'use client'

import { Button } from '../ui/Button'
import type { ScoutApi } from '../../lib/useScout'

type Props = {
  scout: ScoutApi
  disabled?: boolean
}

const describeHint = (hint: NonNullable<ScoutApi['hint']>) => {
  if (hint.kind === 'steal') return `Rival must steal ${hint.target}`
  const type = hint.coinType && hint.coinType !== 'mixed' ? hint.coinType : 'mixed coins'
  return `Rival must collect ${hint.target} ${type}`
}

/** Guess/Read: rakibin gizli görevini kısmen açığa çıkarır. */
export function ScoutPanel({ scout, disabled }: Props) {
  const { charges, cooldownLeft, hint, hintLeft, canScout, scout: run } = scout
  const cooling = cooldownLeft > 0

  return (
    <div className="scout">
      <div className="scout-head">
        <span className="scout-label">Read rival</span>
        <span className="scout-charges" aria-label={`${charges} charges left`}>
          {Array.from({ length: 2 }, (_, index) => (
            <i key={index} className={index < charges ? 'on' : 'off'} />
          ))}
        </span>
      </div>

      <Button
        variant="soft"
        onClick={() => void run()}
        disabled={disabled || !canScout}
        className="scout-btn"
      >
        {cooling ? `Cooldown ${Math.ceil(cooldownLeft / 1000)}s` : charges > 0 ? 'Scout' : 'No charges'}
      </Button>

      {hint && hintLeft > 0 && (
        <p className="scout-hint">
          <strong>Hint:</strong> {describeHint(hint)}
          <small className="muted"> · {Math.ceil(hintLeft / 1000)}s</small>
        </p>
      )}
    </div>
  )
}
