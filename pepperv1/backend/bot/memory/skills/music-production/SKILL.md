---
name: music_production
description: Create professional-quality music across all genres using real synthesis engines, sample libraries, and production techniques. From distorted guitars to orchestral arrangements, from Kendrick-style layered hip-hop to classical piano sonatas. Artistic vision first, technical execution second. No toy sounds. No MIDI beeps. Real music.
---

# Music Production Skill

You are not a programmer who generates audio. You are a composer, producer, sound designer, arranger, and mix engineer who happens to work through code. Every note has intent. Every silence has purpose. Every frequency has a home.

---

## Part I: The Artistic Mind

### The Composer's Philosophy

Before touching a single tool, you think like a composer. Every piece of music begins with an emotional intention. What should the listener feel at second 0? At second 30? At the climax? At the final note?

Music is not notes arranged in time. Music is tension, release, surprise, comfort, chaos, and resolution. Every technical decision serves the emotional arc. If you cannot articulate the emotional purpose of a section, that section has no right to exist.

**The Three Questions (ask before every composition)**:
1. What is the emotional journey? (Map it: beginning state -> ending state)
2. Where is the peak? (Every piece needs a moment of maximum intensity)
3. What is the one thing that makes this piece different? (A single memorable element)

### The 12 Artistic Principles

1. **Emotion Before Theory**: Theory explains why something works. Emotion decides what to try. Never let "correct" override "beautiful." A "wrong" note played with conviction is more powerful than a "right" note played without feeling.

2. **Contrast Creates Impact**: Loud matters because quiet came first. A distorted guitar hits harder after a clean passage. A drop hits because the build existed. The human ear measures in differences, not absolutes.

3. **Space Is an Instrument**: What you leave out defines a piece as much as what you put in. Silence between notes. Air between frequencies. Rest between phrases. Miles Davis: "Don't play what's there. Play what's not there."

4. **Repetition With Variation**: The human ear craves patterns. The human mind craves novelty. Give both. Repeat a phrase, but change one note. Same rhythm, different timbre. Same chord, different voicing. This is the fundamental tension of all music.

5. **Build Early, Reveal Late**: Establish your sonic world in the first 8 bars. The listener should know the vibe. But hold something back for the second half. A new instrument. A key change. A counter-melody that was hiding. Withholding creates anticipation.

6. **Serve the Song, Not the Sound**: A beautiful synth patch that fights the vocal is wrong. A "boring" pad that makes the melody soar is right. Every element must justify its presence. Kill your darlings.

7. **Transitions Are Everything**: The moment between sections is where amateur music reveals itself. A professional track breathes through its transitions. Risers, filter sweeps, drum fills, silence, reverse reverb, tape stops. Plan every transition deliberately.

8. **The Hook Is Sacred**: Whether it's a melodic phrase, a rhythmic figure, a chord change, or a texture, every piece needs something the listener can grab onto and remember. The hook doesn't need to be complex. It needs to be inevitable.

9. **Dynamics Are the Emotional Thermostat**: A piece that stays at one volume is a piece that says nothing. Use the full dynamic range. pp to ff. Whisper to scream. The envelope of the whole song matters as much as the envelope of each note.

10. **Timbre Is the New Harmony**: In modern production, the choice of sound IS the composition. A saw wave and a piano playing the same notes create entirely different emotional worlds. Sound design is composition.

11. **Reference Relentlessly**: A/B your output against professional tracks in the same genre. Not to copy, but to calibrate. Your ears lie to you after 30 minutes. Reference tracks are truth serum.

12. **Ship It**: A finished piece at 85% of your vision is worth infinitely more than a perfect piece that never exists. Perfection is the enemy of art. Set a deadline. Hit it. Move on.

### Emotional Mapping

Before composing, map the emotional arc:

```
EMOTIONAL ARC TEMPLATE:

Time:     0%----10%----25%----50%----75%----90%----100%
Emotion:  [curiosity]->[comfort]->[tension]->[release]->[peak]->[reflection]->[resolution]
Energy:   [3]-------->[5]------>[7]------->[4]------>[9]---->[3]--------->[5]
Key:      [Em]------->[Em]----->[Cm]------>[Em]----->[G]--->[Em]-------->[Em]

Section:  [Intro]---->[Verse]-->[Pre-Ch]-->[Chorus]->[Drop]->[Bridge]--->[Outro]
Density:  [sparse]--->[med]---->[building]->[full]--->[MAX]->[stripped]-->[med]
```

The curve should never be flat for two consecutive sections. If verse 1 and verse 2 are at the same energy, add a new instrument to verse 2 or strip one from verse 1.

---

## Part II: The Complete Toolchain

### Tier 0: The Python Composition Core

Before synthesis, you need composition. These Python tools handle MIDI generation, theory, and the bridge between ideas and sound.

#### music21 (Music Theory Engine)
The computational musicology backbone. Generates, analyzes, and transforms music using formal music theory.

```bash
pip install music21
```

**Core Capabilities**:
- Key detection, scale analysis, Roman numeral analysis
- Chord generation with extensions (9ths, 11ths, 13ths, altered)
- Voice leading algorithms (smoothest path between chords)
- Counterpoint checking (parallel fifths, hidden octaves)
- MIDI export for rendering through any synthesis engine
- MusicXML export for notation

**Example - Generate a Neo-Soul Progression with Voice Leading**:
```python
from music21 import stream, chord, note, tempo, midi, key

s = stream.Stream()
s.append(tempo.MetronomeMark(number=85))
s.append(key.Key('D'))

# Dmaj9 -> Gmaj9 -> Em9 -> A13
progression = [
    ['D3', 'F#3', 'A3', 'C#4', 'E4'],   # Dmaj9
    ['G2', 'B2', 'D3', 'F#3', 'A3'],     # Gmaj9
    ['E3', 'G3', 'B3', 'D4', 'F#4'],     # Em9
    ['A2', 'C#3', 'E3', 'G3', 'B3'],     # A13 (partial)
]

for i, pitches in enumerate(progression):
    c = chord.Chord(pitches)
    c.quarterLength = 4
    # Humanize: slight velocity variation
    for n in c.notes:
        n.volume.velocity = 75 + (i * 3) % 15
    s.append(c)

mf = midi.translate.streamToMidiFile(s)
mf.open('neosoul_progression.mid', 'wb')
mf.write()
mf.close()
```

#### midiutil (Direct MIDI Creation)
When you need precise control over every MIDI parameter: velocity curves, CC automation, pitch bend, timing offsets.

```bash
pip install midiutil
```

**Example - Humanized Piano Part with Velocity Curves**:
```python
from midiutil import MIDIFile
import random

midi = MIDIFile(1)
midi.addTempo(0, 0, 72)

# Chord progression with humanized timing and velocity
chords = [
    ([60, 64, 67, 71], 4),  # Cmaj7
    ([65, 69, 72, 76], 4),  # Fmaj7
    ([62, 65, 69, 72], 4),  # Dm7
    ([67, 71, 74, 77], 4),  # G7
]

beat = 0
for pitches, dur in chords:
    for j, p in enumerate(pitches):
        # Humanize: stagger chord notes by 0-30ms (in beats)
        offset = random.uniform(0, 0.02)
        # Velocity: inner voices quieter
        vel = random.randint(70, 85) if j in [0, len(pitches)-1] else random.randint(55, 70)
        midi.addNote(0, 0, p, beat + offset, dur - 0.1, vel)
    beat += dur

with open("piano_part.mid", "wb") as f:
    midi.writeFile(f)
```

#### pretty_midi (MIDI Analysis and Synthesis)
Clean API for MIDI manipulation. Can synthesize MIDI to audio directly via FluidSynth.

```bash
pip install pretty_midi
```

```python
import pretty_midi

pm = pretty_midi.PrettyMIDI()
piano = pretty_midi.Instrument(program=0)  # Acoustic Grand Piano

# Create an arpeggiated chord
for i, pitch in enumerate([60, 64, 67, 72]):
    note = pretty_midi.Note(
        velocity=80 + i*5,
        pitch=pitch,
        start=i * 0.15,
        end=i * 0.15 + 2.0
    )
    piano.notes.append(note)

pm.instruments.append(piano)
# Synthesize directly (requires FluidSynth + SoundFont)
audio = pm.fluidsynth(fs=44100, sf2_path='GeneralUser.sf2')
# Or save MIDI for external rendering
pm.write('arpeggio.mid')
```

#### pedalboard (Spotify's Audio Processing)
The production-grade effects chain. Processes audio 300x faster than pySoX. Can load ANY VST3 plugin.

```bash
pip install pedalboard
```

**Example - Professional Mastering Chain**:
```python
from pedalboard import Pedalboard, Compressor, Gain, LadderFilter, Reverb, Limiter, HighpassFilter, LowShelfFilter, HighShelfFilter
from pedalboard.io import AudioFile

with AudioFile("mix.wav") as f:
    audio = f.read(f.frames)
    sr = f.samplerate

board = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=30),          # Remove sub rumble
    LowShelfFilter(cutoff_frequency_hz=80, gain_db=2),  # Warm low end
    Compressor(threshold_db=-18, ratio=3, attack_ms=10, release_ms=100),
    HighShelfFilter(cutoff_frequency_hz=10000, gain_db=1.5),  # Air
    Reverb(room_size=0.15, wet_level=0.08),          # Glue reverb
    Limiter(threshold_db=-1.0),                       # Ceiling
    Gain(gain_db=-0.3),                               # Final headroom
])

mastered = board(audio, sr)

with AudioFile("mastered.wav", "w", sr, mastered.shape[0]) as f:
    f.write(mastered)
```

**Loading VST3 Plugins** (use Vital, Surge XT, or any installed VST3):
```python
from pedalboard import load_plugin

synth = load_plugin("C:/Program Files/Common Files/VST3/Vital.vst3")
print(synth.parameters.keys())  # See all tweakable parameters
```

#### librosa (Audio Analysis and MIR)
The standard for music information retrieval. Analyze existing tracks to understand their structure.

```bash
pip install librosa
```

```python
import librosa

y, sr = librosa.load("reference_track.wav")
tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
chroma = librosa.feature.chroma_stft(y=y, sr=sr)
# Use this to analyze reference tracks: what key, what tempo, what harmonic content
```

---

### Tier 1: Professional Synthesis Engines

#### SuperCollider (Primary Synthesis Engine)
Real-time audio synthesis server with a full programming language. Produces studio-quality sound through physical modeling, granular synthesis, additive, subtractive, FM, wavetable, and every other synthesis method.

```bash
choco install supercollider
```

**Architecture**: scsynth (synthesis server) + sclang (language client). Write SynthDefs in sclang, compile to server. Control via OSC from Python, Node.js, or any language.

**Example - Concert Grand Piano (Physical Model)**:
```supercollider
SynthDef(\concertPiano, {
    arg freq=440, amp=0.3, gate=1, pan=0;
    var sig, env, harmonics, hammer, body;

    // Harmonic series with inharmonicity (real pianos have slightly sharp upper partials)
    harmonics = Mix.fill(12, { |i|
        var n = i + 1;
        var inharmonicity = 0.0004; // B coefficient for piano strings
        var partialFreq = freq * n * (1 + (inharmonicity * n * n)).sqrt;
        var partialAmp = 1 / (n ** 1.5) * // Natural harmonic rolloff
            if(n.odd, 1, 0.7); // Even harmonics slightly softer
        SinOsc.ar(partialFreq + Rand(-0.3, 0.3), 0, partialAmp)
    });

    // Hammer impact noise (the initial 'thunk')
    hammer = HPF.ar(WhiteNoise.ar(0.15), 2000) *
        EnvGen.kr(Env.perc(0.001, 0.008));

    // Soundboard resonance
    body = BPF.ar(harmonics, freq * 1.01, 0.3, 0.15);

    sig = harmonics + hammer + body;

    // Piano envelope: fast attack, slow decay, sustain pedal behavior
    env = EnvGen.kr(
        Env.new([0, 1, 0.6, 0.3, 0],
                [0.003, 0.1, 2.0, 3.0],
                [-4, -2, -3, -4]),
        gate, doneAction: 2
    );

    sig = sig * env * amp;

    // Subtle stereo spread based on register
    sig = Pan2.ar(sig, pan + (freq.cpsmidi - 60 / 88 * 0.6 - 0.3));

    // Sympathetic string resonance simulation
    sig = sig + (CombL.ar(sig, 0.05, freq.reciprocal * 2, 0.5) * 0.05);

    Out.ar(0, sig)
}).add;
```

**Example - Screaming Distorted Guitar (Waveguide + Tube Amp Model)**:
```supercollider
SynthDef(\heavyGuitar, {
    arg freq=220, amp=0.5, drive=30, tone=0.6, gate=1;
    var sig, env, exciter, body, cab;

    // Excitation: pick attack + string noise
    exciter = Impulse.ar(0) + (Dust.ar(5) * 0.05) + (PinkNoise.ar(0.02));

    // Karplus-Strong string with nonlinear feedback
    sig = Pluck.ar(
        exciter + WhiteNoise.ar(0.3),
        gate,
        freq.reciprocal, freq.reciprocal,
        decaytime: 6,
        coef: 0.2 + (tone * 0.3)
    );

    // Pickup simulation: two positions blended
    sig = (BPF.ar(sig, freq * 2.5, 0.4) * 0.6) + // Bridge pickup (bright)
          (BPF.ar(sig, freq * 1.2, 0.6) * 0.4);   // Neck pickup (warm)

    // Multi-stage tube amp distortion
    sig = (sig * drive).tanh;                  // First stage: soft clip
    sig = (sig * (drive * 0.5)).fold2(0.9);    // Second stage: fold distortion
    sig = BPF.ar(sig, freq * 3, 0.5) + sig;   // Presence peak
    sig = (sig * (drive * 0.3)).tanh;          // Third stage: final saturation

    // Tone stack (Fender-style)
    sig = BLowShelf.ar(sig, 300, 1, -3);       // Scoop low mids
    sig = BPeakEQ.ar(sig, 800, 1, -2);         // Cut mud
    sig = BHiShelf.ar(sig, 3000, 1, tone * 6); // Presence control

    env = EnvGen.kr(Env.adsr(0.005, 0.05, 0.9, 0.3), gate, doneAction: 2);
    sig = sig * env * amp;

    // Cabinet simulation: 4x12 closed-back character
    cab = LPF.ar(sig, 4500);
    cab = HPF.ar(cab, 75);
    cab = BPeakEQ.ar(cab, 2500, 0.7, 3); // Speaker resonance peak
    cab = FreeVerb.ar(cab, 0.15, 0.3, 0.2); // Room mic bleed

    Out.ar(0, Pan2.ar(cab, 0))
}).add;
```

**Example - Smooth Fretless Bass**:
```supercollider
SynthDef(\fretlessBass, {
    arg freq=110, amp=0.6, gate=1, slide=0;
    var sig, env, vibrato, fretNoise;

    // Slight vibrato (characteristic of fretless)
    vibrato = SinOsc.kr(5, 0, freq * 0.008);

    // Core tone: triangle-ish wave for warm fretless character
    sig = LFTri.ar(freq + vibrato, 0, 0.7) +
          SinOsc.ar(freq + vibrato, 0, 0.3) +          // Fundamental reinforcement
          SinOsc.ar((freq + vibrato) * 2, 0, 0.15) +   // Second harmonic (mwah)
          SinOsc.ar((freq + vibrato) * 3, 0, 0.05);    // Third harmonic

    // The "mwah" - fretless signature: resonant filter sweep on attack
    sig = RLPF.ar(sig,
        EnvGen.kr(Env.new([freq * 6, freq * 3, freq * 2], [0.05, 0.3], [-3, -2]), gate) + vibrato,
        0.3
    );

    // Finger noise on attack
    fretNoise = HPF.ar(PinkNoise.ar(0.03), 2000) *
        EnvGen.kr(Env.perc(0.002, 0.02));
    sig = sig + fretNoise;

    env = EnvGen.kr(Env.adsr(0.01, 0.15, 0.8, 0.15), gate, doneAction: 2);
    sig = sig * env * amp;

    // DI tone: slight low boost, gentle compression
    sig = BLowShelf.ar(sig, 80, 1, 3);
    sig = Compander.ar(sig, sig, 0.3, 1, 0.5, 0.01, 0.1);

    Out.ar(0, Pan2.ar(sig, 0))
}).add;
```

**Example - Lush Analog Pad (Juno-Style)**:
```supercollider
SynthDef(\junoPad, {
    arg freq=220, amp=0.3, gate=1, cutoff=2000, res=0.3, chorusRate=0.5;
    var sig, env, chorus;

    // Three slightly detuned sawtooths (classic Juno supersaw)
    sig = Mix([
        Saw.ar(freq * 0.998),
        Saw.ar(freq * 1.0),
        Saw.ar(freq * 1.002)
    ]) / 3;

    // Sub oscillator (one octave down, square)
    sig = sig + (Pulse.ar(freq * 0.5, 0.5) * 0.2);

    // Resonant low-pass filter with slow LFO modulation
    sig = RLPF.ar(sig,
        cutoff + SinOsc.kr(0.15, 0, cutoff * 0.3),
        res
    );

    // Juno-style chorus (three tapped delays with LFO modulation)
    chorus = Mix.fill(3, { |i|
        DelayC.ar(sig, 0.05,
            SinOsc.kr(chorusRate + (i * 0.13), i * 2pi/3, 0.003, 0.01)
        )
    }) / 3;
    sig = (sig * 0.5) + (chorus * 0.5);

    env = EnvGen.kr(Env.adsr(0.8, 0.5, 0.7, 2.0, curve: -2), gate, doneAction: 2);
    sig = sig * env * amp;

    Out.ar(0, Pan2.ar(sig, 0))
}).add;
```

**Example - Orchestral Strings Section**:
```supercollider
SynthDef(\orchestralStrings, {
    arg freq=440, amp=0.25, gate=1, expression=0.7;
    var sig, env, vibrato, section;

    // Slow vibrato onset (real players don't vibrate immediately)
    vibrato = SinOsc.kr(
        5 + LFNoise1.kr(0.3, 0.5), // Vibrato rate with human variation
        0,
        freq * 0.005 * EnvGen.kr(Env.new([0, 0, 1], [0.4, 0.6])) // Delayed onset
    );

    // String section: 4 "players" with slight detuning and timing offset
    section = Mix.fill(4, { |i|
        var detune = Rand(-1.5, 1.5); // Each player slightly off
        var delay = Rand(0.01, 0.04); // Each player enters slightly different time
        var playerFreq = freq + detune + vibrato;
        var playerSig;

        // Each string is a filtered sawtooth (bowed string spectrum)
        playerSig = Saw.ar(playerFreq) + Saw.ar(playerFreq * 2.001, 0.3);
        playerSig = LPF.ar(playerSig, freq * 4 + (expression * freq * 4));

        // Bowing pressure variation per player
        playerSig = playerSig * (0.8 + LFNoise1.kr(0.5 + (i * 0.1), 0.2));

        DelayN.ar(playerSig, 0.05, delay)
    }) / 4;

    // Resonant body of the instrument
    sig = BPF.ar(section, freq * 1.5, 0.5, 0.2) + section;

    env = EnvGen.kr(
        Env.adsr(0.3, 0.2, 0.8, 0.5, curve: 2), // Slow attack for legato
        gate, doneAction: 2
    );

    sig = sig * env * amp * expression;

    // Hall reverb (essential for string realism)
    sig = FreeVerb.ar(sig, 0.4, 0.8, 0.3);

    Out.ar(0, Pan2.ar(sig, Rand(-0.3, 0.3))) // Slight random pan per instance
}).add;
```

#### Csound (Orchestral and Academic Precision)
Nearly 1,700 unit generators. Unrivaled sound quality. The most battle-tested synthesis system in existence (since 1985).

```bash
choco install csound
pip install ctcsound
```

**Architecture**: Orchestra (.orc) defines instruments. Score (.sco) defines notes. Unified .csd files contain both. Can be driven entirely from Python via ctcsound.

**Example - French Horn with Breath Dynamics**:
```csound
<CsoundSynthesizer>
<CsOptions>
-o horn_output.wav -W
</CsOptions>
<CsInstruments>
sr = 44100
ksmps = 32
nchnls = 2
0dbfs = 1

instr 1 ; French Horn
  ifreq = p4
  iamp = p5
  idur = p3

  ; Breath pressure envelope (characteristic horn swell)
  kBreath linseg 0.3, idur*0.2, 0.9, idur*0.6, 0.7, idur*0.2, 0
  kBreath = kBreath * iamp

  ; Lip vibrato (delayed onset, increasing depth)
  kVibDepth linseg 0, idur*0.3, 0, idur*0.3, ifreq*0.006, idur*0.4, ifreq*0.004
  kVibrato oscil kVibDepth, 5.2

  ; Core: band-limited sawtooth filtered to horn spectrum
  aSaw vco2 kBreath, ifreq + kVibrato, 0
  aSaw2 vco2 kBreath * 0.5, (ifreq + kVibrato) * 2.01, 0

  ; Horn bell filter (characteristic resonance)
  aHorn moogladder aSaw + aSaw2, 1800 + (kBreath * 3000), 0.15

  ; Formant peaks (brass instrument formants)
  aF1 reson aHorn, 500, 100, 1
  aF2 reson aHorn, 1200, 150, 1
  aF3 reson aHorn, 2400, 200, 1

  aOut = (aHorn * 0.5) + (aF1 * 0.2) + (aF2 * 0.15) + (aF3 * 0.1)

  ; Breath noise
  aNoise noise 0.01 * kBreath, 0
  aNoise butterhp aNoise, 3000

  aFinal = aOut + aNoise

  ; Hall reverb for orchestral placement
  aRvbL, aRvbR reverbsc aFinal, aFinal, 0.85, 12000
  outs aFinal + aRvbL*0.3, aFinal + aRvbR*0.3
endin
</CsInstruments>
<CsScore>
i 1  0  4  277  0.4  ; C#4 horn call
i 1  4  3  330  0.5  ; E4
i 1  7  5  440  0.6  ; A4 swell
</CsScore>
</CsoundSynthesizer>
```

**Example - Lush String Ensemble**:
```csound
<CsoundSynthesizer>
<CsOptions>
-o strings_output.wav -W
</CsOptions>
<CsInstruments>
sr = 44100
ksmps = 32
nchnls = 2
0dbfs = 1

instr 1 ; String Ensemble
  ifreq = p4
  iamp = p5

  ; Multiple detuned sawtooths for section width
  a1 vco2 iamp, ifreq * 0.998, 0
  a2 vco2 iamp, ifreq * 1.002, 0
  a3 vco2 iamp * 0.7, ifreq * 2.001, 0

  aSum = a1 + a2 + a3

  ; Slow filter modulation (bowing pressure)
  kFiltFreq oscil 800, 0.3, -1, 0
  aFilt moogladder aSum, 2000 + kFiltFreq, 0.2

  ; Amplitude envelope (slow attack for legato strings)
  aEnv madsr 0.8, 0.3, 0.7, 1.2

  aOut = aFilt * aEnv

  ; Stereo spread
  aRvbL, aRvbR reverbsc aOut, aOut, 0.82, 10000
  outs aOut + aRvbL*0.35, aOut + aRvbR*0.35
endin
</CsInstruments>
<CsScore>
i 1  0  4  261  0.3
i 1  0  4  329  0.25
i 1  0  4  392  0.25
i 1  4  4  349  0.3
i 1  4  4  440  0.25
i 1  4  4  523  0.25
</CsScore>
</CsoundSynthesizer>
```

#### Surge XT (Open-Source Hybrid Synthesizer with CLI)
The most powerful option for scripted synthesis. Full CLI/headless mode. Python bindings via surgepy. 2000+ factory presets.

```bash
choco install surge-xt
pip install surgepy
```

**Why Surge XT is a game-changer**:
- Full headless render: `surge-xt-cli --patch mypatch.fxp --midi input.mid --wav output.wav`
- Python bindings for complete programmatic control
- 3 oscillators (classic, wavetable, FM, S&H, window), 24 filter types, 8 effects slots
- 2000+ factory presets across every synthesis type
- Lua scripting for formula modulator and wavetable generation
- OSC control for every parameter

**Python Example - Render a Synth Pad**:
```python
import surgepy
import numpy as np
import soundfile as sf

s = surgepy.createSurge(44100)
s.loadPatch("factory_presets/Pads/Warm Analog Pad.fxp")

# Play a chord
s.playNote(0, 60, 100, 0)  # C4
s.playNote(0, 64, 90, 0)   # E4
s.playNote(0, 67, 85, 0)   # G4

# Render 4 seconds of audio
samples = []
for _ in range(int(44100 * 4 / 32)):  # 32 samples per block
    buf = s.process()
    samples.append(buf.copy())

audio = np.concatenate(samples, axis=1)
sf.write("surge_pad.wav", audio.T, 44100)
```

#### ChucK (Strongly-Timed Audio Programming)
From Princeton/Stanford CCRMA. Time is a first-class value. Sample-accurate, deterministic scheduling. Perfect for algorithmic composition where timing precision matters.

```bash
# Download from chuck.cs.princeton.edu/release/
# Provides chuck.exe CLI binary
```

**Example - Generative Ambient Piece**:
```chuck
// Ambient generative composition in ChucK
SinOsc s1 => NRev rev => dac;
SinOsc s2 => rev;
TriOsc s3 => LPF lpf => rev;

0.4 => rev.mix;
0.3 => s1.gain;
0.2 => s2.gain;
0.15 => s3.gain;
800 => lpf.freq;

// Scale: D Dorian
[62, 64, 65, 67, 69, 71, 72, 74] @=> int scale[];

while (true) {
    // Random note from scale
    Std.mtof(scale[Math.random2(0, scale.size()-1)]) => s1.freq;
    Std.mtof(scale[Math.random2(0, scale.size()-1)] - 12) => s2.freq;
    Std.mtof(scale[Math.random2(0, scale.size()-1)] + 12) => s3.freq;

    // Vary filter
    Math.random2f(400, 2000) => lpf.freq;

    // Humanized timing
    Math.random2f(0.3, 0.8)::second => now;
}
```

#### FAUST (Functional Audio DSP)
Write DSP algorithms in a functional language, compile to C++, VST3, LV2, WebAssembly, or dozens of other targets. Extremely high-performance generated code.

```bash
# Download from faust.grame.fr
# Or use online IDE: faustide.grame.fr
```

**Example - Custom Reverb Algorithm**:
```faust
import("stdfaust.lib");

// Schroeder reverb with modulated allpass filters
reverb = _ <: par(i, 4, comb(i)) :> allpass_chain
with {
    comb(i) = fi.fb_comb(1024, del(i), 1, fb(i))
    with {
        del(i) = ba.take(i+1, (1117, 1188, 1277, 1356));
        fb(i) = 0.84;
    };
    allpass_chain = fi.allpass_comb(1024, 556, 0.5)
                  : fi.allpass_comb(1024, 441, 0.5);
};

process = _ : reverb;
```

Compile: `faust2[target] reverb.dsp` (e.g., `faust2vst`, `faust2ladspa`, `faust2supercollider`)

#### TidalCycles (Pattern Engine)
Haskell-based pattern language controlling SuperCollider. Unmatched for rhythmic complexity, polyrhythms, and generative patterns.

```bash
# Requires SuperCollider + SuperDirt quark
# Install TidalCycles via cabal:
cabal install tidal
```

**Example - Layered Afrobeat-Influenced Beat**:
```haskell
d1 $ stack [
  s "bd(3,8)" # gain 1.1,
  s "~ sd ~ sd" # gain 0.9 # room 0.2,
  s "hh*8" # gain (range 0.5 0.8 $ sine),
  s "~ ~ ~ cp" # gain 0.6 # delay 0.3,
  s "[congas:2 ~ congas:0 congas:1]*2" # gain 0.7,
  s "shaker*16" # gain (range 0.2 0.5 $ perlin)
  ]
  # cps (120/60/4)

-- Polyrhythmic variation: 5 against 4
d2 $ s "tabla(5,8)" # gain 0.6 # room 0.15
```

---

### Tier 2: Sample-Based Engines

#### FluidSynth + SoundFonts
The bridge between MIDI composition and realistic instrument sounds. Renders SoundFont (.sf2) files in real-time or offline.

```bash
choco install fluidsynth
pip install pyfluidsynth
```

**Essential SoundFont Library** (curated for maximum quality):

| SoundFont | Size | Best For | Quality |
|-----------|------|----------|---------|
| Salamander Grand Piano | 1.9 GB | Solo piano, classical | Gold standard. 16 velocity layers |
| Sonatina Symphonic Orchestra | 1.3 GB | Orchestral scoring | Real recorded samples |
| Virtual Playing Orchestra | 2 GB | Full orchestra | CC0 license, excellent quality |
| VSCO2 Community Edition | 3 GB | Film scoring, orchestral | CC0, 19 instruments, 3000 samples |
| GeneralUser GS | 30 MB | Quick prototyping, all GM sounds | Best bang-for-size ratio |
| Timbres of Heaven | 440 MB | Rich GM, wide coverage | Warm, professional tone |
| Arachno SoundFont | 150 MB | Better pads, warm synths | Richer than GeneralUser |

**Rendering Pipeline**:
```bash
# Offline render (perfect quality, zero artifacts)
fluidsynth -F output.wav -T wav -r 44100 Salamander.sf2 composition.mid

# Layer multiple SoundFonts for different instruments
fluidsynth -F output.wav piano.sf2 strings.sf2 drums.sf2 composition.mid

# Real-time playback on Windows
fluidsynth -a dsound Salamander.sf2 composition.mid
```

**Python Integration**:
```python
import fluidsynth

fs = fluidsynth.Synth()
fs.start(driver="dsound")  # Windows audio driver
sfid = fs.sfload("Salamander.sf2")
fs.program_select(0, sfid, 0, 0)  # Channel, SoundFont, bank, preset

# Play notes programmatically
fs.noteon(0, 60, 100)   # Channel 0, C4, velocity 100
time.sleep(1)
fs.noteoff(0, 60)
```

#### Hydrogen (Advanced Drum Machine)
Pattern-based drum sequencer with humanization controls. Huge library of community drum kits.

```bash
# Download from hydrogen-music.org
```

```bash
# Headless render
hydrogen -s mysong.h2song -o output.wav

# OSC control from external scripts
# Hydrogen listens on configurable OSC port
```

---

### Tier 3: Audio Processing and Mastering

#### SoX (Sound eXchange)
The Swiss Army knife of audio. Command-line, scriptable, powerful.

```bash
choco install sox
```

**Professional Operations**:
```bash
# Mix stems with individual volume control
sox -m -v 1.0 drums.wav -v 0.8 bass.wav -v 0.6 keys.wav -v 0.7 guitar.wav mix.wav

# Mastering chain
sox mix.wav mastered.wav \
    highpass 30 \
    equalizer 60 1q +2 \
    equalizer 250 2q -2 \
    equalizer 3000 1.5q +1.5 \
    equalizer 12000 1q +1 \
    compand 0.01,0.3 -70:-60,-30:-20,-20:-15,0:-6 -6 \
    gain -n -1

# Create risers and transitions
sox -n riser.wav synth 4 whitenoise fade t 0 4 0 gain -10 treble +10

# Tape stop effect
sox input.wav tape_stop.wav speed 1:0.1 fade t 0 2 0

# Reverse reverb transition
sox next_section_start.wav reversed.wav reverse
sox reversed.wav reverbed.wav reverb 80 50 100
sox reverbed.wav transition.wav reverse fade t 0 3 0

# Vinyl crackle / lo-fi texture
sox -n crackle.wav synth 30 brownnoise gain -25 \
    sinc 200-4000 \
    echos 0.8 0.7 40 0.25 63 0.3

# Sidechain-style ducking (render kick then use as envelope)
sox kick.wav -n stat 2>&1  # Analyze kick timing for manual ducking

# Time stretch without pitch change
sox input.wav stretched.wav tempo 0.85

# Pitch shift without time change
sox input.wav shifted.wav pitch 200  # +200 cents = +2 semitones
```

#### FFmpeg (Format Conversion and Advanced Audio)

```bash
choco install ffmpeg
```

```bash
# Mix multiple stems with precise volume control
ffmpeg -i drums.wav -i bass.wav -i keys.wav -i vocals.wav \
  -filter_complex \
  "[0:a]volume=1.0[d];[1:a]volume=0.85[b];[2:a]volume=0.6[k];[3:a]volume=0.9[v];\
   [d][b][k][v]amix=inputs=4:duration=longest" \
  mix.wav

# Apply EQ chain
ffmpeg -i input.wav -af \
  "highpass=f=30,\
   equalizer=f=80:t=h:w=100:g=2,\
   equalizer=f=250:t=h:w=200:g=-2,\
   equalizer=f=3000:t=h:w=1000:g=1.5,\
   equalizer=f=12000:t=h:w=3000:g=1" \
  output.wav

# Concatenate sections in order
ffmpeg -i intro.wav -i verse.wav -i chorus.wav \
  -filter_complex "[0:a][1:a][2:a]concat=n=3:v=0:a=1" \
  full_song.wav

# Crossfade between sections (2 second crossfade)
ffmpeg -i section1.wav -i section2.wav \
  -filter_complex "acrossfade=d=2:c1=tri:c2=tri" \
  crossfaded.wav

# Convert to streaming formats
ffmpeg -i master.wav -codec:a libmp3lame -b:a 320k master.mp3
ffmpeg -i master.wav -codec:a flac master.flac
ffmpeg -i master.wav -codec:a aac -b:a 256k master.m4a
```

#### LilyPond + Abjad (Publication-Quality Notation)
Text-based music engraving. Produces the most beautiful sheet music in existence.

```bash
choco install lilypond
pip install abjad
```

```python
import abjad

# Build a piano score programmatically
treble = abjad.Staff([
    abjad.Note("c'4"), abjad.Note("e'4"),
    abjad.Note("g'4"), abjad.Note("c''4"),
])
bass = abjad.Staff([
    abjad.Note("c,2"), abjad.Note("g,2"),
])
score = abjad.Score([treble, bass])
abjad.show(score)  # Renders via LilyPond to PDF
```

---

### Tier 4: Notation and Text-Based Composition

#### ABC Notation + abcMIDI
Ultra-lightweight text notation. Perfect for quick melodic ideas.

```bash
# Download Windows binaries from abcmidi.sourceforge.io
```

```
X:1
T:Quick Melody Sketch
M:4/4
L:1/8
K:Cmaj
|: CDEF | GABc | c2 BA | G4 :|
```

```bash
abc2midi melody.abc -o melody.mid
fluidsynth -F melody.wav GeneralUser.sf2 melody.mid
```

---

## Part III: Music Theory (The Composer's Complete Vocabulary)

### Scales and Modes

| Scale/Mode | Intervals | Emotional Quality | Use For |
|---|---|---|---|
| Major (Ionian) | W-W-H-W-W-W-H | Bright, happy, triumphant | Pop anthems, celebrations |
| Natural Minor (Aeolian) | W-H-W-W-H-W-W | Sad, reflective, dark | Ballads, R&B |
| Dorian | W-H-W-W-W-H-W | Minor but warm, soulful | Jazz, neo-soul, lo-fi |
| Mixolydian | W-W-H-W-W-H-W | Major but edgy, bluesy | Rock, blues, classic soul |
| Phrygian | H-W-W-W-H-W-W | Dark, exotic, aggressive | Metal, flamenco |
| Lydian | W-W-W-H-W-W-H | Dreamy, ethereal, floating | Film scores, ambient |
| Locrian | H-W-W-H-W-W-W | Unstable, dissonant | Rare. Metal riffs, horror |
| Harmonic Minor | W-H-W-W-H-3H-H | Dramatic, classical tension | Classical, metal, film |
| Melodic Minor (asc) | W-H-W-W-W-W-H | Smooth, jazz sophistication | Jazz improvisation |
| Pentatonic Major | W-W-3H-W-3H | Simple, universal, catchy | Hooks, world music |
| Pentatonic Minor | 3H-W-W-3H-W | Bluesy, raw, powerful | Blues, rock solos |
| Blues Scale | 3H-W-H-H-3H-W | Gritty, expressive | Blues, jazz, soul |
| Whole Tone | W-W-W-W-W-W | Dreamlike, floating | Impressionist, transitions |
| Diminished (HW) | H-W-H-W-H-W-H-W | Mysterious, tense | Jazz, horror, passing |
| Diminished (WH) | W-H-W-H-W-H-W-H | Dominant tension | Jazz dom7 improvisation |
| Hungarian Minor | W-H-3H-H-H-3H-H | Exotic, dramatic | Eastern European, film |
| Hirajoshi | W-H-2W-H-2W | Japanese, contemplative | World music, ambient |
| Phrygian Dominant | H-3H-H-W-H-W-W | Middle Eastern, flamenco | World music, metal |

### Chord Progressions (The Emotional Engine)

#### Pop / Rock Foundations
| Name | Progression | Feel | Examples |
|---|---|---|---|
| The Axis | I - V - vi - IV | Anthemic, universal | "Let It Be", "With or Without You" |
| The Sensitive | vi - IV - I - V | Yearning, emotional | "Numb", "Africa" |
| The Doo-Wop | I - vi - IV - V | Classic, nostalgic | "Stand By Me" |
| The Andalusian | i - VII - VI - V | Dark descending drama | "Hit the Road Jack" |
| The Power | I - IV - V | Driving, raw | "Twist and Shout" |
| The Pachelbel | I - V - vi - iii - IV - I - IV - V | Grand, building | Canon in D |
| The Creep | I - III - IV - iv | Yearning, bittersweet | "Creep" (Radiohead) |
| The Deceptive | I - V - vi | Unresolved beauty | Countless ballads |

#### Jazz / Neo-Soul
| Name | Progression | Feel |
|---|---|---|
| ii-V-I | ii7 - V7 - Imaj7 | Resolution, sophistication |
| Minor ii-V-i | iiø7 - V7b9 - imin7 | Dark resolution |
| Backdoor | iv7 - bVII7 - Imaj7 | Warm surprise |
| Coltrane Changes | Imaj7 - bIIImaj7 - Vmaj7 | Kaleidoscopic |
| Modal Vamp | Imin7 - IVmin7 | Open, floating |
| Neo-Soul Cycle | Imaj9 - IVmaj9 - ii9 - V13 | Warm, complex |
| Rhythm Changes | I - vi - ii - V (fast) | Bebop energy |
| Turnaround | Imaj7 - vi7 - ii7 - V7 | Classic cycling |

#### Hip-Hop / Trap
| Approach | Description |
|---|---|
| Dark Minor Loops | i - VI - VII - i with 808s |
| Soulful Sample Chops | Rearranged soul/jazz chord hits |
| Ambient Pads | Sustained minor chords, heavy reverb/delay |
| Pluck Patterns | Short, arpeggiated minor patterns with trap drums |
| Pitched 808 Melodies | 808 bass as melodic instrument |

### Advanced Harmony

#### Modal Interchange (Borrowed Chords)
Borrowing chords from parallel modes. In C major, borrow from C natural minor:
- **bVII** (Bb major): Rock anthem chord. Immensely common
- **iv** (F minor): Darkening effect. "Everybody Hurts" (REM)
- **bVI** (Ab major): Emotional drop. "Space Oddity" (Bowie)
- **bIII** (Eb major): Cinematic weight

Voice leading from borrowed chords back to diatonic creates smooth chromatic contrary motion. This is the #1 tool for emotional contrast without modulating.

#### Chromatic Mediants
Roots a third apart sharing exactly one common tone (unlike diatonic thirds which share two). Creates dramatic color shifts with minimal voice leading.

- C major -> E major (chromatic upper mediant): Bright, magical
- C major -> Ab major (chromatic lower mediant): Dark, cinematic
- C major -> Eb major (chromatic mediant): Rich, unexpected

Used constantly in film scoring. John Williams, Hans Zimmer, Howard Shore.

#### Tritone Substitution
Replace any dominant V7 with bII7 (whose root is a tritone away). G7 -> Db7 in C major. Works because they share the same tritone interval (B and F / Cb and F). Creates chromatic bass motion: Dm7 -> Db7 -> Cmaj7 (descending by half step).

#### Negative Harmony
Mirror chords around the axis between root and fifth. In C: the axis between C and G.
- C major becomes F minor
- G major becomes C minor
- Am becomes Eb major
Creates "shadow" versions of familiar progressions.

#### Quartal and Quintal Harmony
Stack fourths (quartal) or fifths (quintal) instead of thirds. Creates open, modern, ambiguous sound. McCoy Tyner's signature. Common in modern film scoring and jazz.

- Quartal voicing on C: C-F-Bb-Eb
- Quintal voicing on C: C-G-D-A

#### Secondary Dominants
Any diatonic chord can be temporarily tonicized with its own V7. In C major:
- V7/ii = A7 -> Dm
- V7/iii = B7 -> Em
- V7/IV = C7 -> F
- V7/V = D7 -> G
- V7/vi = E7 -> Am

Creates forward motion and momentary key-center shifts.

#### Augmented Sixth Chords
Pre-dominant chords that resolve outward by half step to the dominant:
- **Italian 6th** (It+6): b6 - 1 - #4 (Ab-C-F# in C)
- **French 6th** (Fr+6): b6 - 1 - 2 - #4 (Ab-C-D-F#)
- **German 6th** (Ger+6): b6 - 1 - b3 - #4 (Ab-C-Eb-F#)

The #4 and b6 resolve outward to the dominant octave. Dramatic, classical tension.

### Melodic Writing

#### Contour Principles
- **Step-wise motion** (conjunct) creates smoothness and singability
- **Leaps** (disjunct) create energy and drama
- **The Gap-Fill Principle**: After a melodic leap, the melody tends to fill in the gap by moving stepwise in the opposite direction. Exploit this for naturally flowing melodies
- **Arch contour**: The most common and satisfying shape. Melody rises to a peak, then descends
- **Pentatonic bias**: The most memorable melodies worldwide tend to be pentatonic. "Happy Birthday", "Amazing Grace", "Swing Low Sweet Chariot"

#### Motif Development Techniques
Take a short melodic idea (2-8 notes) and develop it:
- **Repetition**: Same motif, same pitch
- **Sequence**: Same motif, different starting pitch (up or down by step)
- **Inversion**: Flip intervals (up becomes down, down becomes up)
- **Retrograde**: Play the motif backwards
- **Augmentation**: Double the note durations (stretch in time)
- **Diminution**: Halve the note durations (compress in time)
- **Fragmentation**: Use only part of the motif
- **Extension**: Add notes to the end of the motif
- **Ornamentation**: Add grace notes, trills, passing tones

Beethoven's 5th: the entire symphony is built from one 4-note motif (da-da-da-DUM) using these techniques.

#### The Art of the Hook
Research-backed principles for memorable melodies:
1. Melodic range of a 5th to an octave (too narrow = boring, too wide = unsignable)
2. Predominantly step-wise with one or two strategic leaps
3. Rhythmic repetition (the rhythm of the hook should be simple and repeatable)
4. Resolution to a stable scale degree (1, 3, or 5) at phrase end
5. Syncopation against the beat for rhythmic interest
6. Pentatonic core with passing chromatic color

### Counterpoint (Multi-Voice Writing)

#### Species Counterpoint Rules (adapted for modern use)
1. **No parallel fifths or octaves** between any two voices (sounds hollow, breaks independence)
2. **Contrary motion preferred**: When one voice goes up, the other goes down
3. **Voice crossing**: Generally avoid (each voice should maintain its register)
4. **Dissonance on weak beats**, consonance on strong beats (in traditional style)
5. **Leap resolution**: Large leaps should resolve by step in the opposite direction

#### Practical Counterpoint
For pop/rock/electronic, strict counterpoint rules are guidelines, not laws. But the principles create richer, more independent-sounding parts:
- Counter-melody should have a different rhythm than the main melody
- Counter-melody should move in contrary motion when possible
- Counter-melody should fill in the rests of the main melody
- Both melodies should make harmonic sense with the underlying chords

### Rhythm and Groove

#### Time Signatures and Feel
- **4/4**: Standard. Pop, rock, hip-hop, electronic, R&B
- **3/4**: Waltz. Ballads, folk, some jazz
- **6/8**: Compound duple. Blues, Afrobeat, ballads with a flowing feel
- **12/8**: Slow blues, gospel, doo-wop ballads
- **7/8**: Uneven, driving. Progressive rock, Balkan. (2+2+3 or 3+2+2)
- **5/4**: Unsettled. "Take Five", film scores. (3+2 or 2+3)
- **7/4**: Pink Floyd's "Money". Expansive, unusual

#### Groove Techniques
- **Swing**: Push every other eighth note late (typically 60-67% ratio). Jazz, neo-soul, lo-fi
- **Straight**: Grid-locked timing. EDM, pop, punk
- **Syncopation**: Accent off-beats. Funk, Latin, Afrobeat
- **Ghost Notes**: Very quiet notes (velocity 20-40) between main hits. Creates "pocket"
- **Humanization**: Random timing offsets (+-10ms) and velocity variation (+-10). Prevents robotic feel
- **Polyrhythm**: Two patterns simultaneously: 3 against 4, 5 against 4
- **Metric modulation**: Changing tempo by reinterpreting a rhythmic value (triplets become the new pulse)

#### Clave Patterns (The Foundation of Afro-Diasporic Rhythm)
These patterns underlie salsa, samba, funk, Afrobeat, and much of pop:

```
Son Clave 3-2:    X . . X . . X . . . X . X . . .
Son Clave 2-3:    . . X . X . . . X . . X . . X .
Rumba Clave 3-2:  X . . X . . . X . . X . X . . .
Bossa Nova Clave: X . . X . . X . . . X . . X . .
```

The clave doesn't have to be played explicitly. It's the underlying feel that all other parts relate to.

### Orchestration Essentials

#### Instrument Ranges (Concert Pitch)
| Instrument | Low | High | Sweet Spot |
|---|---|---|---|
| Violin | G3 | E7 | G4-E6 |
| Viola | C3 | A6 | C4-A5 |
| Cello | C2 | A5 | C3-G4 |
| Double Bass | E1 | G4 | E2-G3 |
| Flute | C4 | C7 | D5-D6 |
| Oboe | Bb3 | A6 | C4-G5 |
| Clarinet (Bb) | D3 | Bb6 | E3-C6 |
| Bassoon | Bb1 | Eb5 | C2-D4 |
| French Horn | B1 | F5 | F2-C5 |
| Trumpet (Bb) | F#3 | D6 | G3-C5 |
| Trombone | E2 | Bb4 | F2-Bb4 |
| Tuba | D1 | F4 | F1-Bb3 |
| Piano | A0 | C8 | C2-C6 |
| Guitar | E2 | B5 | E3-E5 |
| Voice (Soprano) | C4 | C6 | E4-A5 |
| Voice (Alto) | F3 | F5 | A3-D5 |
| Voice (Tenor) | C3 | C5 | E3-A4 |
| Voice (Bass) | E2 | E4 | G2-D4 |

#### Blending and Doubling
- Strings + strings = rich, warm, bigger
- Strings + woodwinds = sweet, clear, classical
- Brass + brass = powerful, majestic
- Brass + strings = epic, cinematic
- Woodwinds at the octave = bright, penetrating
- Doubling the melody at the octave = more prominent without more volume
- Doubling in unison = wider, chorus-like
- Horns doubling cello melody = heroic, warm

#### The Rimsky-Korsakov Principles
1. When instruments play in their extreme registers, the sound becomes thinner and more strained. Use this for tension, not comfort.
2. The most blending occurs when instruments play in similar registers. Spacing matters.
3. Woodwinds in thirds or sixths create sweetness. Brass in unison creates power.
4. Wide spacing in the bass, close spacing in the treble (like piano chord voicing).
5. Timpani reinforces bass notes. It does not substitute for them.

---

## Part IV: Sound Design from First Principles

### How Acoustic Instruments Produce Sound
Every acoustic instrument has three components:
1. **Exciter**: What creates the initial energy (pick, bow, hammer, breath, stick)
2. **Resonator**: What shapes the frequency content (string, tube, membrane, body)
3. **Radiator**: What projects the sound (soundboard, bell, body)

To synthesize a realistic instrument, you model all three.

### Harmonic Spectra of Real Instruments
Understanding the harmonic content of real instruments is crucial for synthesis:

- **Piano**: Slightly inharmonic partials (upper partials sharper than mathematical harmonics due to string stiffness). Inharmonicity coefficient B ≈ 0.0004 for mid-range. Rich attack transient from hammer impact
- **Violin**: Strong odd AND even harmonics. Formant peaks around 300Hz, 1000Hz, 2500Hz. Bow pressure creates a sawtooth-like waveform
- **Clarinet**: Predominantly odd harmonics (like a square wave). This gives it its hollow, woody tone
- **Flute**: Nearly sinusoidal (very few upper harmonics). Breath noise adds air
- **Guitar**: Rich harmonic content. Pick position determines which harmonics are emphasized. Bridge = bright (more upper harmonics). Neck = warm (more fundamental)
- **Brass**: All harmonics present, with spectral centroid shifting up with louder playing (brighter when louder)
- **Drums**: Inharmonic spectra. Modes of vibration don't form a harmonic series

### ADSR Shapes for Realistic Instruments
| Instrument | Attack | Decay | Sustain | Release | Notes |
|---|---|---|---|---|---|
| Piano | 3-5 ms | 1-3 sec | 20-30% | 0.5-1 sec | Long decay, no real sustain without pedal |
| Violin (bowed) | 50-300 ms | 200 ms | 70-90% | 100-300 ms | Slow attack for legato, fast for spiccato |
| Guitar (picked) | 1-3 ms | 0.5-2 sec | 10-20% | 0.3-1 sec | Pluck = instant attack |
| Flute | 30-80 ms | 100 ms | 80% | 100-200 ms | Breath onset |
| Trumpet | 20-50 ms | 50 ms | 85% | 50-100 ms | Lip-controlled attack |
| Drums | < 1 ms | 50-500 ms | 0% | 50-200 ms | Pure percussive envelope |
| Pad/Strings | 500-2000 ms | 500 ms | 70-80% | 1-3 sec | Slow everything |
| Bass (fingered) | 5-15 ms | 200 ms | 60% | 100-200 ms | Quick but not instant |
| Organ | 1-5 ms | 0 ms | 100% | 5-20 ms | Instant on/off |

### Expression and Humanization
Making programmed music feel alive:

1. **Velocity variation**: Real players never hit the same velocity twice. Random +-5 to +-15 on every note
2. **Timing micro-offsets**: Shift notes +-10ms from the grid. Bass slightly behind the beat = relaxed groove. Hi-hats slightly ahead = driving feel
3. **Vibrato modeling**: Real vibrato has delayed onset (0.2-0.5s), variable rate (4-7Hz), and variable depth. NOT a perfect sine wave
4. **Articulation**: Staccato (short), legato (connected), accent (louder), tenuto (held full duration). Each requires different envelope shapes
5. **Dynamic arcs within phrases**: Notes within a phrase should have a dynamic shape (usually crescendo to the peak note, decrescendo after)
6. **Imperfection is beauty**: Slight pitch drift, inconsistent tone, uneven dynamics. These are not bugs, they are what makes music human

---

## Part V: Arrangement and Structure

### Song Structures by Genre

```
Pop/Rock:     Intro(4-8) | V1(8-16) | PreCh(4-8) | Ch(8-16) | V2(8-16) | PreCh | Ch | Bridge(8) | Ch | Outro(4-8)
Hip-Hop:      Intro(4-8) | V1(16) | Hook(8) | V2(16) | Hook(8) | V3(16) | Hook(8) | Outro(4-8)
Electronic:   Intro(16) | Build(8) | Drop(16) | Break(8) | Build(8) | Drop(16) | Outro(8)
Classical:    Exposition | Development | Recapitulation (Sonata Form)
Jazz:         Head(32) | Solo Chorus(32*N) | Head Out(32)
Film Score:   Theme Statement | Variation | Tension | Resolution
R&B:          Intro(4) | V1(8) | PreCh(4) | Ch(8) | V2(8) | Ch | Bridge(8) | Ch(extended) | Outro
```
Numbers in parentheses = typical bar count.

### The Energy Curve

```
     *         * *
    * *       *   *
   *   *     *     * *
  *     *   *         *
 *       * *           *
*                       *
|Intro|V1|Ch|V2|Ch|Br|Ch|Out|
  3    5  8  6  8  4  9  5     <- Energy level (1-10)
```

**Rule**: Never let two consecutive sections have the same energy level. If V2 feels like V1, add a new instrument, change the drum pattern, or modulate.

### Layering Strategy

**Foundation Layer** (always present):
- Kick drum pattern
- Bass line (sub for electronic, upright/electric for acoustic)
- Main chord instrument (piano, guitar, synth pad)

**Rhythm Layer** (groove and movement):
- Snare / clap (backbeat)
- Hi-hats / ride / shakers
- Percussion (congas, tambourine, claves)

**Melody Layer** (foreground):
- Lead vocal / lead synth / lead instrument
- Counter-melody (enters later for depth)
- Call-and-response elements

**Texture Layer** (atmosphere and glue):
- Pads, drones, ambient sounds
- Reverb tails, delay trails
- Risers, sweeps, ear candy, foley

**Rule of Density**:
- Intro: Foundation only
- Verse: Foundation + Rhythm
- Pre-Chorus: Foundation + Rhythm + Melody (building)
- Chorus: All four layers
- Bridge: Strip back to 1-2 layers, then rebuild
- Outro: Deconstruct layers one by one

### Transition Techniques (The Professional's Secret)

Amateur music: sections start and stop abruptly. Professional music: every section flows into the next.

1. **Reverse Reverb**: Bounce the first note/chord of the next section, reverse it, add long reverb, fade in. Creates a "sucking in" effect before the downbeat
2. **Drum Fill**: 1-2 beat fill on toms/snare rolls before section change
3. **Filter Sweep**: Gradually open or close a low-pass filter across the last 2-4 bars
4. **Riser/Noise Sweep**: Ascending pitched noise building tension. Use SoX: `sox -n riser.wav synth 4 whitenoise fade t 0 4 0 gain -10 treble +10`
5. **Drop Out**: Remove ALL instruments except one for 1-2 beats. The silence creates enormous anticipation
6. **Tape Stop**: Pitch/speed slow dramatically. `sox input.wav tape_stop.wav speed 1:0.1 fade t 0 2 0`
7. **Pre-Chorus Lift**: Raise melody or add high harmony in the last 4 bars before the chorus
8. **Key Change (Truck Driver)**: Modulate up a half/whole step for the final chorus. Cheap but effective
9. **Rhythmic Displacement**: Shift the groove slightly (start a hi-hat pattern a beat early)
10. **Counter-Melody Introduction**: New melodic line that bridges two sections
11. **Impact + Silence**: Big crash/hit followed by a beat of silence before the next section
12. **Swell**: Crescendo on a sustained chord or pad into the next section
13. **Half-Time / Double-Time**: Change the rhythmic feel at the section boundary
14. **Vocal Pickup**: Last syllable of the previous section overlaps into the next
15. **Automation Snapshot**: Gradually change reverb, delay, or filter across the transition bar

### Modulation Techniques (Key Changes)

| Type | How | Effect | Example |
|---|---|---|---|
| Pivot Chord | Use a chord common to both keys | Smooth, almost invisible | C: Am -> F -> (Am = vi in C, ii in G) -> D -> G |
| Common Tone | Hold one note while changing harmony around it | Ethereal, surprising | C major -> Db major (share the note C/Db enharmonic) |
| Direct/Abrupt | Just change keys with no preparation | Dramatic, in-your-face | End verse in E minor, start chorus in G major |
| Chromatic | Slide all voices by half step | Smooth, cinematic | Cmaj7 -> Dbmaj7 |
| Truck Driver | Up a half/whole step | Climactic, final chorus energy | "Man in the Mirror" (Michael Jackson) |
| Deceptive | Resolve V7 to bVI instead of I | Surprise, continued motion | G7 -> Ab (expected C) |

---

## Part VI: Mixing and Mastering

### Frequency Allocation

| Range | Name | Instruments | Action |
|---|---|---|---|
| 20-60 Hz | Sub | Sub bass, kick (fundamental) | Feel more than hear. Mono. Don't crowd |
| 60-250 Hz | Bass | Bass guitar, kick body, low synths | Warmth. HPF everything that doesn't belong |
| 250-500 Hz | Low Mid | Guitar body, piano low end, snare body | **MUD ZONE**. Cut aggressively here |
| 500 Hz-2 kHz | Mid | Vocals, lead instruments, guitar mid | **Clarity zone**. Most important range |
| 2-6 kHz | Upper Mid | Vocal presence, guitar attack, snare crack | Presence. Harsh if overloaded |
| 6-12 kHz | High | Cymbals, air, sibilance | Brilliance. Easy to fatigue ears |
| 12-20 kHz | Air | Breathiness, sparkle | Subtle "openness". Boost gently |

### The Mixing Checklist (In Order)

1. **Level Balance First**: Get the rough mix right with faders only. No effects. If it doesn't sound good here, effects won't save it
2. **High-Pass Everything**: HPF every track that doesn't need sub content. Vocals: 80-100Hz. Guitar: 80-120Hz. Keys: 60-100Hz. This cleans ENORMOUS amounts of mud
3. **Pan for Width**: Kick, bass, lead vocal = dead center. Guitars, keys = spread (30-80%). Backing vocals, percussion, ear candy = wide (70-100%)
4. **EQ Carving**: Every instrument gets its own frequency "pocket." Cut before boosting. If the vocal needs more presence at 3kHz, try cutting the guitar at 3kHz first
5. **Compression**: Tame dynamics. Fast attack = control, slow attack = punch. Ratio 2:1-4:1 for most sources. 10:1+ for limiting
6. **Reverb and Delay**: Create depth. Short reverb = close/intimate, long reverb = far/epic. Tempo-synced delays for rhythmic coherence. Use sends, not inserts (so multiple instruments share the same reverb "space")
7. **Stereo Check**: Sum to mono. Nothing should disappear entirely. If it does, you have phase issues

### Advanced Mixing Techniques

- **Parallel Compression**: Blend an uncompressed signal with a heavily compressed copy. Preserves transients while adding sustain and thickness. The "New York compression" trick
- **Mid/Side EQ**: Process the center (mid) and sides independently. Boost highs on sides for width. Cut mud from mid for clarity
- **Frequency Ducking**: Instead of full sidechain compression, only duck specific frequency ranges. Duck bass frequencies of the pad when the kick hits, but leave the highs untouched
- **Transient Shaping**: Boost or reduce the attack transient of drums without changing sustain. More attack = more punch. Less attack = softer feel
- **Saturation/Harmonics**: Add subtle harmonic distortion to individual tracks for warmth and presence. Tape saturation, tube warmth, transistor grit

### Mastering Chain

```bash
# SoX mastering chain
sox mix.wav mastered.wav \
    highpass 25 \
    equalizer 60 1q +1.5 \
    equalizer 250 2q -1.5 \
    equalizer 3000 1.5q +1 \
    equalizer 12000 1q +1 \
    compand 0.005,0.2 -70:-60,-30:-20,-20:-15,0:-6 -6 \
    gain -n -1

# Python mastering with pedalboard
from pedalboard import Pedalboard, Compressor, Limiter, HighpassFilter, \
    LowShelfFilter, HighShelfFilter, Gain
from pedalboard.io import AudioFile

with AudioFile("mix.wav") as f:
    audio = f.read(f.frames)
    sr = f.samplerate

chain = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=25),
    LowShelfFilter(cutoff_frequency_hz=80, gain_db=1.5),
    Compressor(threshold_db=-20, ratio=2.5, attack_ms=15, release_ms=150),
    HighShelfFilter(cutoff_frequency_hz=10000, gain_db=1),
    Limiter(threshold_db=-1.0),
    Gain(gain_db=-0.3),
])

mastered = chain(audio, sr)
with AudioFile("mastered.wav", "w", sr, mastered.shape[0]) as f:
    f.write(mastered)
```

**Target Loudness**:
- Streaming (Spotify, Apple Music): -14 LUFS
- CD: -9 to -12 LUFS
- Broadcast: -23 LUFS (EBU R128)
- Club music: -6 to -9 LUFS (louder, more compressed)

---

## Part VII: Genre-Specific Production Blueprints

### Classical / Orchestral
- **Engine**: Csound (physical models) + FluidSynth (Sonatina/VPO SoundFonts)
- **Composition**: music21 for theory-correct part writing, LilyPond for notation
- **Key Elements**: Legato lines, dynamic expression (pp to ff), voice leading, counterpoint
- **Reverb**: Large hall, 2-4 second tail. Essential for orchestral realism
- **Mixing**: Orchestral balance follows natural acoustic: strings loudest, then winds, then brass/percussion. Wide stereo image mimicking concert hall seating

### Hip-Hop / Trap
- **Engine**: SuperCollider (808 bass, drum synthesis) + FluidSynth (sampled instruments) + pedalboard (effects)
- **Approach**: Beat first. Melody on top. Leave space for vocals
- **Key Elements**: Hard kick/808 (30-60Hz sub), crisp snare/clap, hi-hat rolls (triplets, 32nds), dark minor melodic loops
- **Processing**: Sidechain compression (duck everything on kick), heavy low-end saturation, tape warmth, half-speed reverb on melodics
- **Drums**: 808 kick tuned to key. Snare at 2 and 4. Hi-hats with velocity rolls. Occasional open hat
- **The Kendrick Approach**: Layered vocal textures, unconventional samples (jazz records, African percussion), genre-bending structure, thematic coherence across tracks

### Jazz
- **Engine**: FluidSynth (Salamander Piano + acoustic bass SF2) or Csound for acoustic modeling
- **Composition**: music21 for chord changes, walking bass generation, comping patterns
- **Key Elements**: Swing feel (60-67% ratio), extended chords (9ths, 11ths, 13ths), improvisation-style lines with approach tones and enclosures, brush drums
- **Space**: Lots of dynamics. Jazz breathes. Don't compress heavily
- **Authenticity**: Slight timing variation on every note. Bass slightly behind beat. Drums slightly ahead. Piano in between

### Electronic / Ambient
- **Engine**: SuperCollider (synthesis) + Surge XT (wavetable/FM) + TidalCycles (patterns) + pedalboard (effects)
- **Approach**: Sound design IS the composition. Design sounds first, arrange second
- **Key Elements**: Evolving textures, long reverb tails (3-6 seconds), filtered pads, granular processing, generative elements
- **Processing**: Heavy effects chains: reverb -> delay -> chorus -> saturation. Bit crushing for lo-fi. Spectral freezing for drones
- **Build**: Start sparse. Add one element every 8-16 bars. Let sounds evolve slowly

### Rock / Metal
- **Engine**: SuperCollider (distorted guitar waveguide, drum physical models) + FluidSynth (bass, keys)
- **Approach**: Riff-driven. Write the guitar riff, build arrangement around it
- **Key Elements**: Distorted guitars (waveguide + multi-stage tube amp model), tight bass (HPF at 80Hz, boost at 700Hz for growl), powerful drums (big room reverb on snare, tight kick)
- **Mixing**: Rhythm guitars panned hard left and right (100%). Lead guitar center or slight offset. Bass center. Drums: kick and snare center, toms spread, overheads wide
- **The Wall of Sound**: Layer 2-4 guitar tracks panned across stereo field, each with slightly different EQ/amp settings

### R&B / Neo-Soul
- **Engine**: FluidSynth (Rhodes/Wurlitzer SF2) + SuperCollider (synth bass, pads) + Surge XT (warm analog patches)
- **Approach**: Harmony first. Rich chords, then groove, then melody
- **Key Elements**: Extended jazz chords (9ths, 11ths), warm electric piano with chorus, smooth fingered bass, subtle percussion (shakers, snaps), stacked vocal harmonies
- **Processing**: Chorus on keys, tape warmth on everything, subtle compression (2:1), lush reverb (plate), vinyl crackle for lo-fi variants
- **Groove**: Swing at 50-60%. Ghost notes on the snare. Finger snaps or rim clicks on 2 and 4

### Film Score / Cinematic
- **Engine**: Csound (orchestra) + SuperCollider (electronic textures, drones) + VSCO2/Sonatina SoundFonts
- **Approach**: Emotional arc matches visual arc. Theme statement -> development -> tension -> resolution
- **Key Elements**: Orchestral swells, tension drones (low sustained clusters), rhythmic ostinatos, thematic development using motif techniques
- **Layering**: Acoustic orchestra as foundation, electronic textures for modernity, percussion for energy, choir for grandeur
- **Dynamic Range**: Film scores use the widest dynamic range of any genre. Whisper-quiet to thunderous

### Lo-Fi / Chillhop
- **Engine**: FluidSynth (piano SF2) + pedalboard (effects chain) + SoX (vinyl processing)
- **Approach**: Start with a jazz chord loop. Add drum break. Process everything through lo-fi chain
- **Key Elements**: Detuned piano (pitch wobble), vinyl crackle, tape hiss, muffled drums (heavy LPF), side-chained pad, simple bass
- **Processing**: Bit depth reduction (16->12 bit), sample rate reduction (44.1k->22k->44.1k), heavy LPF (4-8kHz cutoff), subtle pitch modulation (0.1-0.3%), tape saturation, vinyl noise layer

### Afrobeat / Afro-Fusion
- **Engine**: SuperCollider (percussion synthesis) + FluidSynth (horns, keys) + TidalCycles (polyrhythmic patterns)
- **Key Elements**: Clave-based rhythm (son or rumba clave), layered percussion (djembe, shekere, congas, talking drum), horn section stabs, Fela Kuti-style organ vamp, Tony Allen-style drumming
- **Groove**: Extended polyrhythmic patterns. Multiple percussion voices interlocking. Everything relates back to the clave
- **Structure**: Long-form (5-15 minutes). Gradual layering. Call-and-response between horns and percussion

### Latin (Salsa/Bossa Nova/Samba)
- **Bossa Nova**: Guitar-based. Syncopated right-hand pattern. Nylon guitar + brushes + upright bass. Gentle, intimate
- **Salsa**: Piano montuno (repeated rhythmic chord pattern), clave, tumbao bass, horn arrangements, call-and-response
- **Samba**: Fast, driving. Surdo (bass drum), tamborim, agogo, cuica, cavaquinho. Multiple interlocking percussion patterns

### Gospel / Worship
- **Engine**: FluidSynth (organ, piano) + SuperCollider (pads)
- **Key Elements**: Hammond organ (drawbar combinations), grand piano, choir (stacked harmonies), bass guitar (melodic walking lines), drums (half-time feel, gospel chops)
- **Harmony**: Extended chords (maj7, 9, 11), chromatic passing chords, secondary dominants everywhere, passing diminished chords
- **Dynamics**: Extreme. Whisper to full-band shout within 4 bars

---

## Part VIII: The Complete Production Pipeline

### Step 1: Concept
```
Define:
- Emotional arc (map it visually)
- Genre/style reference tracks (2-3 specific songs)
- Key, tempo, time signature
- Song structure with bar counts
- The "one thing" that makes this piece unique
```

### Step 2: Compose
```python
# Use music21 or midiutil to generate MIDI
# Build chord progression first
# Add melody / hook
# Write bass line (root movement first, then embellish)
# Plan arrangement: what plays when
# Export MIDI tracks (separate files per instrument)
```

### Step 3: Sound Design
```
# Choose / build instruments:
# - SuperCollider SynthDefs for synthetic sounds
# - SoundFonts for realistic acoustic instruments
# - Surge XT presets for hybrid sounds
# Test each sound in isolation AND in context
# Record or render each stem separately
```

### Step 4: Produce
```bash
# Render stems
fluidsynth -F piano_stem.wav Salamander.sf2 piano.mid
fluidsynth -F strings_stem.wav Sonatina.sf2 strings.mid
# SuperCollider renders via scsynth
# Surge XT renders via surgepy
```

### Step 5: Process and Transition
```python
# Apply per-stem effects with pedalboard
from pedalboard import Pedalboard, Reverb, Chorus, Compressor
from pedalboard.io import AudioFile

# Piano: warm reverb + gentle compression
piano_fx = Pedalboard([Compressor(threshold_db=-15, ratio=2), Reverb(room_size=0.3)])
# Strings: large hall reverb
strings_fx = Pedalboard([Reverb(room_size=0.7, wet_level=0.4)])
# Apply to each stem and save
```

```bash
# Build transitions with SoX
sox -n riser.wav synth 4 whitenoise fade t 0 4 0 gain -10 treble +10
sox chorus_start.wav rev_crash.wav reverse reverb 80 50 100 reverse fade t 0 2 0
```

### Step 6: Mix
```bash
# Mix stems with FFmpeg
ffmpeg -i piano.wav -i strings.wav -i drums.wav -i bass.wav -i riser.wav \
  -filter_complex \
  "[0:a]volume=0.8[p];[1:a]volume=0.6[s];[2:a]volume=1.0[d];\
   [3:a]volume=0.85[b];[4:a]volume=0.3[r];\
   [p][s][d][b][r]amix=inputs=5:duration=longest" \
  mix.wav

# OR with SoX (simpler for basic mixes)
sox -m -v 0.8 piano.wav -v 0.6 strings.wav -v 1.0 drums.wav -v 0.85 bass.wav mix.wav
```

### Step 7: Master
```python
from pedalboard import Pedalboard, Compressor, Limiter, HighpassFilter, \
    LowShelfFilter, HighShelfFilter, Gain
from pedalboard.io import AudioFile

with AudioFile("mix.wav") as f:
    audio = f.read(f.frames)
    sr = f.samplerate

master_chain = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=25),
    LowShelfFilter(cutoff_frequency_hz=80, gain_db=1.5),
    Compressor(threshold_db=-20, ratio=2.5, attack_ms=15, release_ms=150),
    HighShelfFilter(cutoff_frequency_hz=10000, gain_db=1),
    Limiter(threshold_db=-1.0),
    Gain(gain_db=-0.3),
])

mastered = master_chain(audio, sr)
with AudioFile("mastered.wav", "w", sr, mastered.shape[0]) as f:
    f.write(mastered)
```

### Step 8: Export
```bash
# Lossless
ffmpeg -i mastered.wav -codec:a flac mastered.flac

# Streaming (MP3 320kbps)
ffmpeg -i mastered.wav -codec:a libmp3lame -b:a 320k mastered.mp3

# AAC for Apple
ffmpeg -i mastered.wav -codec:a aac -b:a 256k mastered.m4a
```

---

## Part IX: Psychoacoustics (Why Things Sound Good)

### Consonance and Dissonance
- **Octave (2:1)**: Most consonant. Notes fuse together
- **Perfect Fifth (3:2)**: Very consonant. Stable, open
- **Perfect Fourth (4:3)**: Consonant but with tension when in bass
- **Major Third (5:4)**: Warm, happy consonance
- **Minor Third (6:5)**: Sweet, melancholic consonance
- **Minor Second (16:15)**: Maximum dissonance. Tension, bite, edge
- **Tritone (45:32)**: The "devil's interval." Unstable, wants to resolve

Simple frequency ratios = consonance. Complex ratios = dissonance. Use dissonance for tension, consonance for resolution. The journey between them IS music.

### Auditory Masking
When two sounds occupy the same frequency range, the louder one "masks" the quieter one. This is why EQ carving matters: every instrument needs its own frequency "pocket" or they'll fight each other.

- A sound can mask frequencies within about 1/3 octave around it
- Lower frequencies mask higher frequencies more than the reverse
- Simultaneous masking: both sounds at once. Temporal masking: a loud sound briefly masks softer sounds that come immediately after

### Fletcher-Munson Curves (Equal Loudness)
Human ears are less sensitive to low and high frequencies at quiet volumes. At whisper-quiet levels, you barely hear bass or air. At loud levels, the response flattens out.

**Practical implications**:
- Mix at moderate levels (70-80 dB SPL). Your frequency perception is most balanced here
- If a mix sounds good quiet, it will sound incredible loud
- Bass sounds louder at higher playback volumes. Don't over-compensate at low monitoring levels
- The "smiley face" EQ curve (boosted lows and highs) is an attempt to compensate for Fletcher-Munson at low volumes

### The Missing Fundamental
The brain perceives pitch even when the fundamental frequency is absent, as long as enough upper harmonics are present. A speaker that can't reproduce 60Hz will still let you "hear" a 60Hz bass note through its harmonics (120Hz, 180Hz, etc.).

**Practical use**: On small speakers (laptop, phone), the bass fundamental disappears. Add harmonics (saturation/distortion) to the bass so it remains audible through the missing fundamental phenomenon.

---

## Part X: Quick Reference

### Tool Decision Matrix

| I Want To... | Use This |
|---|---|
| Generate chord progressions and theory-correct compositions | music21 (Python) |
| Create precise MIDI with humanization | midiutil or pretty_midi (Python) |
| Synthesize realistic instruments from scratch | SuperCollider (physical modeling) |
| Create orchestral scores with academic precision | Csound |
| Use a CLI-controllable synthesizer with 2000+ presets | Surge XT (surgepy) |
| Generate complex rhythmic patterns | TidalCycles |
| Render MIDI with realistic sampled instruments | FluidSynth + SoundFonts |
| Apply professional effects chains (reverb, compression, EQ) | pedalboard (Python) |
| Load and use VST3 plugins from scripts | pedalboard (Python) |
| Process, mix, and master audio files | SoX + FFmpeg |
| Produce publication-quality sheet music | LilyPond / Abjad |
| Write DSP algorithms that compile to any target | FAUST |
| Time-precise algorithmic composition | ChucK |
| Quickly sketch melodic ideas in text | ABC notation + abcMIDI |
| Analyze audio for tempo, key, structure | librosa (Python) |

### Installation Checklist

```bash
# Core synthesis engines
choco install supercollider
choco install csound
choco install surge-xt
choco install lilypond

# Audio processing
choco install sox
choco install ffmpeg
choco install fluidsynth

# Python ecosystem (the glue)
pip install music21          # Music theory and composition
pip install midiutil         # Direct MIDI file creation
pip install pretty_midi      # MIDI analysis and synthesis
pip install pedalboard       # Spotify's audio effects (load VST3 plugins!)
pip install pyfluidsynth     # FluidSynth Python bindings
pip install librosa          # Audio analysis / MIR
pip install soundfile        # Audio file I/O
pip install ctcsound         # Csound Python bindings
pip install surgepy          # Surge XT Python bindings
pip install abjad            # LilyPond Python API
pip install numpy scipy      # DSP fundamentals

# Download essential SoundFonts:
# - Salamander Grand Piano (search "salamander grand piano sf2")
# - GeneralUser GS (schristiancollins.com/generaluser.php)
# - VSCO2 Community Edition (versilian-studios.com/vsco-community/)
# - Virtual Playing Orchestra (virtualplaying.com)
```

### The Complete Python Pipeline (End-to-End Example)

```python
"""
Complete song production pipeline:
1. Compose with music21 (MIDI generation)
2. Render with FluidSynth (SoundFont -> WAV)
3. Process with pedalboard (Effects)
4. Mix with pedalboard/numpy
5. Master with pedalboard
6. Export with FFmpeg
"""
from music21 import stream, chord, note, tempo, midi, key
from midiutil import MIDIFile
import numpy as np
import subprocess

# --- STEP 1: COMPOSE ---
# Create chord progression
progression_midi = MIDIFile(1)
progression_midi.addTempo(0, 0, 85)

chords_data = [
    ([62, 66, 69, 73, 76], 4),  # Dmaj9
    ([67, 71, 74, 78, 81], 4),  # Gmaj9
    ([64, 67, 71, 74, 78], 4),  # Em9
    ([69, 73, 76, 79, 83], 4),  # A13
]

beat = 0
for pitches, dur in chords_data:
    for j, p in enumerate(pitches):
        import random
        offset = random.uniform(0, 0.015)
        vel = random.randint(65, 80)
        progression_midi.addNote(0, 0, p, beat + offset, dur - 0.1, vel)
    beat += dur

with open("chords.mid", "wb") as f:
    progression_midi.writeFile(f)

# --- STEP 2: RENDER ---
subprocess.run([
    "fluidsynth", "-F", "chords.wav", "-T", "wav",
    "-r", "44100", "Salamander.sf2", "chords.mid"
])

# --- STEP 3: PROCESS ---
from pedalboard import Pedalboard, Reverb, Chorus, Compressor
from pedalboard.io import AudioFile

with AudioFile("chords.wav") as f:
    audio = f.read(f.frames)
    sr = f.samplerate

fx = Pedalboard([
    Compressor(threshold_db=-18, ratio=2.5),
    Chorus(rate_hz=0.3, depth=0.15, mix=0.2),
    Reverb(room_size=0.4, wet_level=0.25),
])
processed = fx(audio, sr)

with AudioFile("chords_processed.wav", "w", sr, processed.shape[0]) as f:
    f.write(processed)

# --- STEP 4-5: MIX AND MASTER ---
# (Mix multiple stems, then apply mastering chain)
# See Steps 6-7 in the pipeline section above

# --- STEP 6: EXPORT ---
subprocess.run([
    "ffmpeg", "-y", "-i", "mastered.wav",
    "-codec:a", "libmp3lame", "-b:a", "320k", "final.mp3"
])
```

---

## Mindset Reminders

- You are composing music. Every note has intent
- Reference professional tracks constantly. A/B your output against the real thing
- If a part sounds "pretty good," push until it sounds inevitable
- Complexity is not sophistication. A single perfect chord change outweighs a thousand notes
- The space between notes is where music lives
- When stuck, subtract. Remove the last thing you added
- Transitions, transitions, transitions. This is where 90% of amateur music falls apart
- Mix at low volume. If it sounds good quiet, it will sound incredible loud
- The missing fundamental is your friend on small speakers. Add harmonics
- Never forget Fletcher-Munson: your ears lie at extreme volumes
- Ship it. A finished piece at 85% is worth more than a perfect piece that never exists
