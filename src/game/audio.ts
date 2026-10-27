// WebAudio playback for the 16 WAVs in assets/audio (gains from audio_manifest.json).
// Started from the player's first button press; mute-safe (every cue also has a caption).

export interface SoundDef { id: string; file: string; loop: boolean; suggestedGain: number }

export class AudioManager {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  sfxBus: GainNode | null = null;
  ambBus: GainNode | null = null;
  buffers = new Map<string, AudioBuffer>();
  defs = new Map<string, SoundDef>();
  raw = new Map<string, ArrayBuffer>();
  loops = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; target: number }>();
  lastPlay = new Map<string, { src: AudioBufferSourceNode; t: number }>();
  volumes = { master: 0.7, sfx: 1, amb: 1, music: 0.8 };
  duck = 1;
  private noiseBuf: AudioBuffer | null = null;
  // music
  musicBus: GainNode | null = null;
  musicDuck = 1;
  musicDefs = new Map<string, { file: string; loopStart?: number; loopEnd?: number }>();
  musicRaw = new Map<string, ArrayBuffer>();
  musicBuf = new Map<string, AudioBuffer>();
  current: { id: string; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  wantMusic: { id: string | null; gain: number; fade: number } = { id: null, gain: 1, fade: 1 };
  // environment reverb (concrete garage)
  private reverbSend: GainNode | null = null;
  reverbAmount = 0.32;

  async preload(base: string, onProgress?: (n: number) => void) {
    const manifest = await (await fetch(base + 'audio_manifest.json')).json();
    const sounds: SoundDef[] = manifest.sounds;
    let done = 0;
    await Promise.all(sounds.map(async (s) => {
      this.defs.set(s.id, s);
      try {
        const r = await fetch(base + s.file.replace(/^audio\//, ''));
        this.raw.set(s.id, await r.arrayBuffer());
      } catch { /* missing sound: captions still carry the cue */ }
      done++; onProgress?.(done / sounds.length);
    }));
  }

  /** Fetch the score in the background (not needed before the first scene). */
  async preloadMusic(base: string) {
    try {
      const man = await (await fetch(base + 'music_manifest.json')).json();
      const all = [...man.tracks, ...man.stingers];
      for (const m of all) this.musicDefs.set(m.id, m);
      // stingers first (small), then tracks
      for (const m of [...man.stingers, ...man.tracks]) {
        try { this.musicRaw.set(m.id, await (await fetch(base + m.file)).arrayBuffer()); } catch { /* optional */ }
        if (this.ctx) await this.decodeMusic(m.id);
      }
      if (this.ctx && this.wantMusic.id && !this.current) this.music(this.wantMusic.id, this.wantMusic);
    } catch { /* music is optional */ }
  }
  private async decodeMusic(id: string) {
    const ctx = this.ctx; const ab = this.musicRaw.get(id);
    if (!ctx || !ab || this.musicBuf.has(id)) return;
    try { this.musicBuf.set(id, await ctx.decodeAudioData(ab.slice(0))); this.musicRaw.delete(id); } catch { /* skip */ }
  }

  /** Must be called from a user gesture. */
  async unlock() {
    if (!this.ctx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      // iPhone: without this, Web Audio follows the ring/silent switch and the game is mute (Safari 16.4+)
      try { const as = (navigator as any).audioSession; if (as && 'type' in as) as.type = 'playback'; } catch { /* older Safari */ }
      this.ctx = new AC() as AudioContext;
      const ctx = this.ctx;
      // resume + a silent tick inside the user gesture (iOS Safari needs both)
      try { ctx.resume(); } catch { /* ignore */ }
      try { const b = ctx.createBuffer(1, 1, 22050); const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start(0); } catch { /* ignore */ }
      this.master = ctx.createGain();
      this.sfxBus = ctx.createGain();
      this.ambBus = ctx.createGain();
      this.musicBus = ctx.createGain();
      // gentle bus compressor so stingers can be loud without clipping
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.25;
      this.sfxBus.connect(this.master); this.ambBus.connect(this.master); this.musicBus.connect(this.master);
      this.master.connect(comp); comp.connect(ctx.destination);
      // concrete room: sfx get a reverb send (footsteps, knocks, metal ring out)
      try {
        const conv = ctx.createConvolver();
        conv.buffer = this.makeIR(ctx, 2.6);
        this.reverbSend = ctx.createGain(); this.reverbSend.gain.value = this.reverbAmount;
        this.sfxBus.connect(this.reverbSend); this.reverbSend.connect(conv); conv.connect(this.master);
      } catch { /* no reverb */ }
      this.applyVolumes();
      await Promise.all([...this.raw.entries()].map(async ([id, ab]) => {
        try { this.buffers.set(id, await ctx.decodeAudioData(ab.slice(0))); } catch { /* skip */ }
      }));
      const n = ctx.sampleRate * 2;
      this.noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      for (const id of [...this.musicRaw.keys()]) await this.decodeMusic(id);
      if (this.wantMusic.id) this.music(this.wantMusic.id, this.wantMusic);
    }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch { /* ignore */ } }
  }

  setVolumes(master: number, sfx: number, amb: number, music = this.volumes.music) {
    this.volumes = { master, sfx, amb, music };
    this.applyVolumes();
  }
  private makeIR(ctx: AudioContext, seconds: number): AudioBuffer {
    const n = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / ctx.sampleRate;
        const k = Math.min(0.92, 0.25 + t * 0.35); // darker as it decays
        lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
        d[i] = lp * Math.exp(-t * 6.9 / seconds) * (t < 0.012 ? t / 0.012 : 1) * 2.2;
      }
    }
    return b;
  }
  /** wet amount of the concrete reverb (garage ≈ .32, car ≈ .18, outdoors ≈ .06) */
  setReverb(v: number, seconds = 0.6) {
    this.reverbAmount = v;
    if (this.ctx && this.reverbSend) this.reverbSend.gain.setTargetAtTime(v, this.ctx.currentTime, seconds / 3);
  }
  private applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master!.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.sfxBus!.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.ambBus!.gain.setTargetAtTime(this.volumes.amb * this.duck, t, 0.05);
    this.musicBus!.gain.setTargetAtTime(this.volumes.music * this.musicDuck, t, 0.05);
  }

  // ---------------------------------------------------------------- music
  /** Crossfade to a looping track (null = silence). Safe to call before load; it starts when ready. */
  music(id: string | null, opts: { gain?: number; fade?: number } = {}) {
    const gain = opts.gain ?? 1, fade = opts.fade ?? 1.5;
    this.wantMusic = { id, gain, fade };
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    if (this.current && this.current.id === id) {
      this.current.gain.gain.cancelScheduledValues(ctx.currentTime);
      this.current.gain.gain.setTargetAtTime(gain, ctx.currentTime, fade / 3);
      return;
    }
    if (this.current) {
      const old = this.current;
      old.gain.gain.cancelScheduledValues(ctx.currentTime);
      old.gain.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
      try { old.src.stop(ctx.currentTime + fade * 2.5 + 0.1); } catch { /* ignore */ }
      this.current = null;
    }
    if (!id) return;
    const buf = this.musicBuf.get(id); const def = this.musicDefs.get(id);
    if (!buf || !def) return; // starts later from preloadMusic()
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    if (def.loopStart !== undefined && def.loopEnd !== undefined && def.loopEnd <= buf.duration) { src.loopStart = def.loopStart; src.loopEnd = def.loopEnd; }
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(g); g.connect(this.musicBus);
    src.start(ctx.currentTime + 0.02, def.loopStart ?? 0);
    g.gain.setTargetAtTime(gain, ctx.currentTime, fade / 3);
    this.current = { id, src, gain: g };
  }
  /** Temporarily lower (or cut) the score. */
  duckMusic(v: number, seconds = 0.4) {
    this.musicDuck = v;
    if (!this.ctx || !this.musicBus) return;
    this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.musicBus.gain.setTargetAtTime(this.volumes.music * v, this.ctx.currentTime, Math.max(0.005, seconds / 3));
  }
  /** One-shot musical hit (impact, braam, scare…), played on the effects bus. */
  sting(id: string, opts: { gain?: number; delay?: number; pan?: number } = {}) {
    const ctx = this.ctx; const buf = this.musicBuf.get(id);
    if (!ctx || !buf) return;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = opts.gain ?? 1;
    src.connect(g);
    if (opts.pan !== undefined && (ctx as any).createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = opts.pan; g.connect(p); p.connect(this.sfxBus!); }
    else g.connect(this.sfxBus!);
    src.start(ctx.currentTime + (opts.delay ?? 0));
  }
  /** Quickly drop / restore ambience (caretaker reveal). */
  setDuck(v: number, seconds = 0.12) {
    this.duck = v;
    if (!this.ctx) return;
    this.ambBus!.gain.setTargetAtTime(this.volumes.amb * v, this.ctx.currentTime, seconds / 3);
  }

  play(id: string, opts: { gain?: number; rate?: number; delay?: number; restart?: boolean; pan?: number; lp?: number } = {}) {
    const ctx = this.ctx; const buf = this.buffers.get(id); const def = this.defs.get(id);
    if (!ctx || !buf || !def) return;
    // no unbounded stacking of the same cue
    const prev = this.lastPlay.get(id);
    if (prev && ctx.currentTime - prev.t < 0.06) return;
    if (prev && opts.restart) { try { prev.src.stop(); } catch { /* ignore */ } }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const g = ctx.createGain();
    g.gain.value = def.suggestedGain * (opts.gain ?? 1);
    let node: AudioNode = g;
    if (opts.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.lp; node.connect(f); node = f; }
    if (opts.pan !== undefined && (ctx as any).createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = opts.pan; node.connect(p); node = p;
    }
    src.connect(g); node.connect(this.sfxBus!);
    const when = ctx.currentTime + (opts.delay ?? 0);
    src.start(when);
    this.lastPlay.set(id, { src, t: when });
  }

  loop(id: string, gain = 1, fade = 0.45) {
    const ctx = this.ctx; const buf = this.buffers.get(id); const def = this.defs.get(id);
    if (!ctx || !buf || !def) return;
    const target = def.suggestedGain * gain;
    const cur = this.loops.get(id);
    if (cur) {
      cur.target = target;
      cur.gain.gain.cancelScheduledValues(ctx.currentTime);
      cur.gain.gain.setTargetAtTime(target, ctx.currentTime, fade / 3);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(g); g.connect(this.ambBus!);
    src.start();
    g.gain.setTargetAtTime(target, ctx.currentTime, fade / 3);
    this.loops.set(id, { src, gain: g, target });
  }

  stopLoop(id: string, fade = 0.45) {
    const ctx = this.ctx; const cur = this.loops.get(id);
    if (!ctx || !cur) return;
    this.loops.delete(id);
    cur.gain.gain.cancelScheduledValues(ctx.currentTime);
    cur.gain.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
    try { cur.src.stop(ctx.currentTime + fade * 2 + 0.05); } catch { /* ignore */ }
  }

  stopAllLoops(fade = 0.45) { for (const id of [...this.loops.keys()]) this.stopLoop(id, fade); }

  // ---------------------------------------------------------------- synthesized layers (no extra files)
  private drone: { gain: GainNode; filter: BiquadFilterNode; oscs: OscillatorNode[] } | null = null;

  /** Low, slowly beating drone under the ambience; level 0 = silent. */
  setDrone(level: number, seconds = 2.5) {
    const ctx = this.ctx; if (!ctx) return;
    if (!this.drone) {
      const gain = ctx.createGain(); gain.gain.value = 0;
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 180; filter.Q.value = 0.8;
      const oscs = [41.2, 41.9, 61.7, 82.6].map((f, i) => {
        const o = ctx.createOscillator(); o.type = i < 2 ? 'sawtooth' : 'sine'; o.frequency.value = f;
        const og = ctx.createGain(); og.gain.value = i < 2 ? 0.5 : 0.22; o.connect(og); og.connect(filter); o.start();
        return o;
      });
      // slow swell
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
      const lg = ctx.createGain(); lg.gain.value = 60; lfo.connect(lg); lg.connect(filter.frequency); lfo.start();
      filter.connect(gain); gain.connect(this.ambBus!);
      this.drone = { gain, filter, oscs };
    }
    this.drone.gain.gain.cancelScheduledValues(ctx.currentTime);
    this.drone.gain.gain.setTargetAtTime(level, ctx.currentTime, seconds / 3);
  }

  private noiseSrc(): AudioBufferSourceNode | null {
    const ctx = this.ctx; if (!ctx || !this.noiseBuf) return null;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; return src;
  }

  private out(pan: number, lp?: number): AudioNode {
    const ctx = this.ctx!;
    let node: AudioNode = this.sfxBus!;
    if ((ctx as any).createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); p.connect(node); node = p; }
    if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; f.connect(node); node = f; }
    return node;
  }

  /** Two soft thumps (warning state). */
  heartbeat(gain = 0.35) {
    const ctx = this.ctx; if (!ctx) return;
    const t0 = ctx.currentTime;
    for (const [dt, g] of [[0, 1], [0.27, 0.7]] as const) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(62, t0 + dt); o.frequency.exponentialRampToValueAtTime(38, t0 + dt + 0.16);
      const a = ctx.createGain(); a.gain.setValueAtTime(0.0001, t0 + dt); a.gain.exponentialRampToValueAtTime(gain * g, t0 + dt + 0.012); a.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.22);
      o.connect(a); a.connect(this.out(0)); o.start(t0 + dt); o.stop(t0 + dt + 0.25);
    }
  }

  /** Knuckles on steel: low thud + short noise tick, n times. */
  knock(gain = 0.5, pan = 0, n = 3, interval = 0.34, lp = 900) {
    const ctx = this.ctx; if (!ctx) return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < n; i++) {
      const t = t0 + i * interval * (0.92 + Math.random() * 0.16);
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(128, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.09);
      const a = ctx.createGain(); a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(gain, t + 0.004); a.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(a); a.connect(this.out(pan, lp)); o.start(t); o.stop(t + 0.2);
      const nz = this.noiseSrc(); if (nz) {
        const ng = ctx.createGain(); ng.gain.setValueAtTime(gain * 0.5, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 1.2;
        nz.connect(bp); bp.connect(ng); ng.connect(this.out(pan, lp * 2)); nz.start(t, Math.random()); nz.stop(t + 0.06);
      }
    }
  }

  /** Distant metal: inharmonic partials with a long tail. */
  clank(gain = 0.18, pan = 0, lp = 2400) {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    const dest = this.out(pan, lp);
    for (const [f, g, d] of [[311, 1, 1.6], [742, 0.6, 1.1], [1189, 0.35, 0.8], [1873, 0.2, 0.5]] as const) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * (0.98 + Math.random() * 0.04);
      const a = ctx.createGain(); a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(gain * g, t + 0.006); a.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(a); a.connect(dest); o.start(t); o.stop(t + d + 0.05);
    }
  }

  /** Low swell that builds and then is cut (reveal). */
  swell(seconds = 2.4, gain = 0.32) {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(90, t); f.frequency.linearRampToValueAtTime(700, t + seconds);
    const a = ctx.createGain(); a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(gain, t + seconds); a.gain.setValueAtTime(0.0001, t + seconds + 0.02);
    for (const fr of [36.7, 37.4, 55.1, 73.9, 110.3]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fr; o.connect(f); o.start(t); o.stop(t + seconds + 0.05);
    }
    f.connect(a); a.connect(this.out(0));
  }

  /** Soft synthesized breath (no breath WAV in the pack): band-passed noise swell. */
  breath(gain = 0.08, dur = 1.6, pan = 0, freq = 520) {
    const ctx = this.ctx; if (!ctx || !this.noiseBuf) return;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(bp); bp.connect(g); g.connect(this.out(pan));
    const t = ctx.currentTime;
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.4);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }
}
