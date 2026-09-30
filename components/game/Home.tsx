'use client'

import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import type { ProgressApi } from '../../lib/useProgress'

type Props = {
  progress: ProgressApi
  onCreate: () => void
  onJoin: (code: string) => void
  busy?: boolean
  error?: string | null
}

const STEPS = ['Create a game', 'Send the link', 'Get a secret mission', 'Beat them']

export function Home({ progress, onCreate, onJoin, busy, error }: Props) {
  const { profile, progress: raw, online } = progress

  return (
    <main className="home">
      <section className="hero">
        <p className="eyebrow">2-player realtime party duel</p>
        <h1>
          DUO <span>CHAOS</span>
        </h1>
        <p className="lede">
          See. Guess. Grab the resource. Break their plan. Finish your secret mission — then rematch.
        </p>
        <div className="hero-actions">
          <Button onClick={onCreate} disabled={busy}>
            {busy ? 'Creating…' : 'Create a game'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              const code = window.prompt('Enter room code')
              if (code) onJoin(code)
            }}
            disabled={busy}
          >
            Join with code
          </Button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <Panel
        title="Your profile"
        subtitle={online ? 'Synced with server' : 'Offline — progress saved locally'}
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
              {raw.xp} XP · {raw.wins}W / {raw.matches}M
            </small>
          </div>
        </div>
      </Panel>

      <ol className="steps">
        {STEPS.map((step, index) => (
          <li key={step}>
            <span>{index + 1}</span>
            {step}
          </li>
        ))}
      </ol>
    </main>
  )
}
