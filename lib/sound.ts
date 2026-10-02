'use client'

/**
 * Bağımlılıksız Web Audio ses motoru.
 * Tüm sesler prosedürel olarak üretilir; harici dosya gerekmez.
 * Tarayıcı autoplay politikası nedeniyle ilk kullanıcı etkileşiminde açılır.
 */

export type SoundName =
  | 'click'
  | 'join'
  | 'countdown'
  | 'start'
  | 'collect'
  | 'risky'
  | 'bump'
  | 'scout'
  | 'chaos'
  | 'jackpot'
  | 'combo'
  | 'streak'
  | 'roundwin'
  | 'win'
  | 'lose'
  | 'emote'

type ToneSpec = {
  freq: number
  to?: number
  dur: number
  type?: OscillatorType
  gain?: number
  delay?: number
}

const RECIPES: Record<SoundName, ToneSpec[]> = {
  click: [{ freq: 420, to: 620, dur: 0.08, type: 'triangle', gain: 0.18 }],
  join: [
    { freq: 520, to: 780, dur: 0.12, type: 'sine', gain: 0.2 },
    { freq: 780, to: 1040, dur: 0.14, type: 'sine', gain: 0.16, delay: 0.1 },
  ],
  countdown: [{ freq: 660, dur: 0.1, type: 'square', gain: 0.14 }],
  start: [
    { freq: 440, to: 880, dur: 0.18, type: 'sawtooth', gain: 0.16 },
    { freq: 880, to: 1320, dur: 0.22, type: 'sawtooth', gain: 0.14, delay: 0.16 },
  ],
  collect: [{ freq: 880, to: 1320, dur: 0.09, type: 'triangle', gain: 0.16 }],
  // Riskli coin (altın/zümrüt/elmas bonus): parlak, yükselen bir "fırsat"
  // sesi — normal toplamadan farklı ki oyuncu büyük ödülü aldığını anlasın.
  risky: [
    { freq: 660, to: 990, dur: 0.1, type: 'triangle', gain: 0.18 },
    { freq: 990, to: 1480, dur: 0.14, type: 'triangle', gain: 0.16, delay: 0.08 },
  ],
  bump: [{ freq: 180, to: 90, dur: 0.12, type: 'square', gain: 0.18 }],
  scout: [
    { freq: 1200, to: 1600, dur: 0.1, type: 'sine', gain: 0.14 },
    { freq: 1600, to: 2000, dur: 0.12, type: 'sine', gain: 0.12, delay: 0.08 },
  ],
  chaos: [
    { freq: 220, to: 110, dur: 0.3, type: 'sawtooth', gain: 0.18 },
    { freq: 330, to: 165, dur: 0.3, type: 'square', gain: 0.12, delay: 0.06 },
  ],
  // Jackpot: parlak, yükselen bir "ödül" arpeji — normal toplama sesinden
  // belirgin şekilde farklı ki oyuncu büyük ödülü aldığını anlasın.
  jackpot: [
    { freq: 784, dur: 0.1, type: 'triangle', gain: 0.2 },
    { freq: 988, dur: 0.1, type: 'triangle', gain: 0.2, delay: 0.09 },
    { freq: 1319, dur: 0.12, type: 'triangle', gain: 0.2, delay: 0.18 },
    { freq: 1568, dur: 0.28, type: 'triangle', gain: 0.22, delay: 0.3 },
    { freq: 2093, dur: 0.3, type: 'sine', gain: 0.14, delay: 0.42 },
  ],
  // Combo: kısa, yükselen tek nota — ardışık toplamada perde yükselir
  // (çağıran taraf `playSound('combo')`'yu hızlandırılmış aralıklarla çalar).
  combo: [{ freq: 1046, to: 1568, dur: 0.08, type: 'triangle', gain: 0.16 }],
  // Streak: combo serisi belirgin bir eşiğe ulaştığında çalan parlak arpej.
  streak: [
    { freq: 1318, dur: 0.08, type: 'triangle', gain: 0.18 },
    { freq: 1760, dur: 0.08, type: 'triangle', gain: 0.18, delay: 0.07 },
    { freq: 2093, dur: 0.16, type: 'sine', gain: 0.16, delay: 0.14 },
  ],
  // Tur sonu kazanma: maç sonu 'win'den daha kısa, tur bazlı bir fanfar.
  roundwin: [
    { freq: 659, dur: 0.12, type: 'triangle', gain: 0.2 },
    { freq: 880, dur: 0.12, type: 'triangle', gain: 0.2, delay: 0.12 },
    { freq: 1174, dur: 0.24, type: 'triangle', gain: 0.18, delay: 0.24 },
  ],
  win: [
    { freq: 523, dur: 0.14, type: 'triangle', gain: 0.2 },
    { freq: 659, dur: 0.14, type: 'triangle', gain: 0.2, delay: 0.14 },
    { freq: 784, dur: 0.22, type: 'triangle', gain: 0.2, delay: 0.28 },
    { freq: 1046, dur: 0.3, type: 'triangle', gain: 0.18, delay: 0.46 },
  ],
  lose: [
    { freq: 392, dur: 0.18, type: 'sine', gain: 0.18 },
    { freq: 330, dur: 0.18, type: 'sine', gain: 0.18, delay: 0.18 },
    { freq: 262, dur: 0.34, type: 'sine', gain: 0.18, delay: 0.36 },
  ],
  emote: [{ freq: 700, to: 1100, dur: 0.1, type: 'triangle', gain: 0.14 }],
}

let ctx: AudioContext | null = null
let master: GainNode | null = null
let muted = false

const STORAGE_KEY = 'duo-chaos:muted'

const readMuted = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const ensureContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  if (ctx) return ctx
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor()
  master = ctx.createGain()
  master.gain.value = 0.9
  master.connect(ctx.destination)
  muted = readMuted()
  return ctx
}

/** İlk kullanıcı etkileşiminde çağrılmalı; autoplay kilidini açar. */
export const unlockAudio = () => {
  const context = ensureContext()
  if (context && context.state === 'suspended') void context.resume()
}

export const isMuted = () => muted

export const setMuted = (value: boolean) => {
  muted = value
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
    } catch {
      /* yoksay */
    }
  }
  if (master && ctx) master.gain.value = value ? 0 : 0.9
}

export const toggleMuted = () => {
  setMuted(!muted)
  return muted
}

const playTone = (context: AudioContext, spec: ToneSpec) => {
  const start = context.currentTime + (spec.delay ?? 0)
  const osc = context.createOscillator()
  const gain = context.createGain()
  osc.type = spec.type ?? 'sine'
  osc.frequency.setValueAtTime(spec.freq, start)
  if (spec.to && spec.to !== spec.freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), start + spec.dur)
  }
  const peak = spec.gain ?? 0.15
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.dur)
  osc.connect(gain)
  gain.connect(master ?? context.destination)
  osc.start(start)
  osc.stop(start + spec.dur + 0.02)
}

/** Tek bir ses efekti çalar. Sessizken veya destek yoksa sessizce döner. */
export const playSound = (name: SoundName) => {
  if (muted) return
  const context = ensureContext()
  if (!context) return
  if (context.state === 'suspended') void context.resume()
  const recipe = RECIPES[name]
  if (!recipe) return
  recipe.forEach((spec) => playTone(context, spec))
}
