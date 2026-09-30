'use client'

import { useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

type Props = {
  open: boolean
  onClose: () => void
  onJoin: (code: string) => void
  busy?: boolean
}

const CODE_LENGTH = 6
const CODE_PATTERN = /^[A-Z0-9]{6}$/

/**
 * In-app room-code entry dialog. Replaces the native `window.prompt` so the
 * join flow matches the rest of the UI.
 */
export function JoinDialog({ open, onClose, onJoin, busy }: Props) {
  const [code, setCode] = useState('')
  const [touched, setTouched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus is handled by <Modal> via the `data-autofocus` attribute below.
  // State is reset by remounting the dialog (see the `key` in Home).
  const normalized = code.trim().toUpperCase()
  const valid = CODE_PATTERN.test(normalized)
  const showError = touched && normalized.length > 0 && !valid

  const submit = () => {
    setTouched(true)
    if (!valid) {
      inputRef.current?.focus()
      return
    }
    onJoin(normalized)
  }

  return (
    <Modal
      open={open}
      title="Join a game"
      subtitle="Enter the 6-character code your friend shared."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !valid}>
            {busy ? 'Joining…' : '🔗 Join game'}
          </Button>
        </>
      }
    >
      <form
        className="join-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label className="field">
          <span className="field-label">Room code</span>
          <input
            ref={inputRef}
            data-autofocus
            className={['code-input', showError ? 'invalid' : ''].filter(Boolean).join(' ')}
            value={code}
            onChange={(event) => {
              const next = event.target.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, CODE_LENGTH)
              setCode(next)
              setTouched(true)
            }}
            placeholder="ABC123"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={CODE_LENGTH}
            aria-invalid={showError}
            aria-describedby={showError ? 'join-code-error' : undefined}
          />
        </label>
        {showError && (
          <p id="join-code-error" className="field-error">
            Codes are {CODE_LENGTH} letters or numbers (e.g. ABC123).
          </p>
        )}
      </form>
    </Modal>
  )
}
