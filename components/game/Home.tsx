'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { AvatarPicker } from './AvatarPicker'
import { JoinDialog } from './JoinDialog'
import type { ProgressApi } from '../../lib/useProgress'

type Props = {
  progress: ProgressApi
  onCreate: (name: string) => void
  onJoin: (code: string, name: string) => void
  /** Tek oyunculu "Play vs Bot" modunu başlatır. */
  onPlayBot: (name: string) => void
  busy?: boolean
  error?: string | null
  /** Kayıtlı görünen ad (localStorage'dan). */
  initialName?: string
}

const STEPS = [
  { icon: '🎮', title: 'Create a room', text: 'One tap and your private arena is ready.' },
  { icon: '🔗', title: 'Send the link', text: 'Your rival joins from any device instantly.' },
  { icon: '🎯', title: 'Chase the mission', text: 'Grab the right coins before they do.' },
  { icon: '🏆', title: 'Score the most', text: 'Highest score after 3 rounds wins.' },
]
const NAME_MAX = 16

export function Home({ progress, onCreate, onJoin, onPlayBot, busy, error, initialName = '' }: Props) {
  const { profile, progress: raw, online } = progress
  const [joinOpen, setJoinOpen] = useState(false)
  const [name, setName] = useState(initialName)
  // Oyun modu seçimi: "friend" (2 oyunculu) veya "bot" (tek oyunculu).
  const [mode, setMode] = useState<'friend' | 'bot'>('friend')

  // HİDRASYON: `initialName` localStorage'dan mount SONRASI gelir (bkz.
  // `useRoom`). Kullanıcı henüz yazmaya başlamadıysa gelen kayıtlı adı input'a
  // yansıtırız. Kullanıcı yazmaya başladıysa (dirty) üzerine YAZMAYIZ.
  //
  // NOT: setState'i mikro-görev (setTimeout 0) içinde yaparız; efekt
  // gövdesinde senkron setState lint kuralı (`react-hooks/set-state-in-effect`)
  // tarafından yasaklanmıştır.
  const nameDirtyRef = useRef(false)
  useEffect(() => {
    if (nameDirtyRef.current) return
    if (!initialName) return
    const id = window.setTimeout(() => {
      if (nameDirtyRef.current) return
      setName((current) => (current === initialName ? current : initialName))
    }, 0)
    return () => window.clearTimeout(id)
  }, [initialName])

  const trimmed = name.trim()
  const nameValid = trimmed.length >= 2

  return (
    <main className="home">
      <div className="home-doodles" aria-hidden>
        <span className="doodle doodle-a">🎮</span>
        <span className="doodle doodle-b">⭐</span>
        <span className="doodle doodle-c">🍬</span>
        <span className="doodle doodle-d">💎</span>
      </div>

      <div className="home-grid">
        <section className="hero">
          <p className="eyebrow">✨ 2-player realtime party duel</p>
          <h1>
            DUO <span>CHAOS</span>
          </h1>
          <p className="lede">
            Two players. One arena. Grab the coins your mission asks for, steal from your rival, and
            finish with the highest score. Fast, chaotic, and best played with a friend.
          </p>

          <div className="name-row">
            <AvatarPicker
              avatar={raw.avatar}
              level={profile.level}
              onSelect={(id) => void progress.setCosmetics({ avatar: id })}
              label="Choose your animal"
              backdrop="light"
            />
            <label className="field name-field">
              <span className="field-label">Your name</span>
              <input
                className="name-input"
                value={name}
                onChange={(event) => {
                  nameDirtyRef.current = true
                  setName(event.target.value.slice(0, NAME_MAX))
                }}
                placeholder="e.g. Melih"
                maxLength={NAME_MAX}
                autoComplete="nickname"
                spellCheck={false}
                aria-label="Your display name"
              />
              <small className="muted">Your rival will see this name and animal.</small>
            </label>
          </div>

          <div className="mode-toggle" role="tablist" aria-label="Game mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'friend'}
              className={['mode-tab', mode === 'friend' ? 'active' : ''].filter(Boolean).join(' ')}
              onClick={() => setMode('friend')}
              disabled={busy}
            >
              <span aria-hidden>👥</span> Play with a Friend
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'bot'}
              className={['mode-tab', mode === 'bot' ? 'active' : ''].filter(Boolean).join(' ')}
              onClick={() => setMode('bot')}
              disabled={busy}
            >
              <span aria-hidden>🤖</span> Play vs Bot
            </button>
          </div>

          <div className="hero-actions">
            {mode === 'friend' ? (
              <>
                <Button onClick={() => onCreate(trimmed)} disabled={busy || !nameValid}>
                  {busy ? 'Creating…' : '🎉 Create a game'}
                </Button>
                <Button variant="ghost" onClick={() => setJoinOpen(true)} disabled={busy || !nameValid}>
                  🔗 Join with code
                </Button>
              </>
            ) : (
              <Button onClick={() => onPlayBot(trimmed)} disabled={busy || !nameValid}>
                {busy ? 'Starting…' : '🤖 Play vs Bot'}
              </Button>
            )}
          </div>
          {mode === 'bot' && (
            <p className="muted bot-hint">
              Single-player match against a medium-difficulty bot. Same rules, same arena.
            </p>
          )}
          {!nameValid && <p className="muted">Pick a name (at least 2 characters) to start.</p>}
          {error && <p className="error">{error}</p>}
        </section>

        <aside className="home-side">
          <Panel
            title="Your profile"
            className="profile-card"
          >
            <div className="profile-row">
              <div className="profile-level">
                <strong>{profile.level}</strong>
                <small>Level</small>
              </div>
              <div className="profile-meta">
                <p className="profile-title">{profile.title}</p>
                <div className="xp-bar" aria-label="XP progress">
                  <span style={{ width: `${Math.round(profile.progress * 100)}%` }} />
                </div>
                <small className="muted">
                  {raw.xp} XP
                </small>
              </div>
            </div>
          </Panel>

          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="step-icon" aria-hidden>
                  {step.icon}
                </span>
                <div className="step-text">
                  <strong>{step.title}</strong>
                  <small>{step.text}</small>
                </div>
                <span className="step-num">{index + 1}</span>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      <JoinDialog
        key={joinOpen ? 'join-open' : 'join-closed'}
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        onJoin={(code) => {
          setJoinOpen(false)
          onJoin(code, trimmed)
        }}
        busy={busy}
        backdrop="light"
      />
    </main>
  )
}
