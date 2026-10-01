'use client'

import { useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { useI18n } from '../../lib/i18n'

type Props = {
  open: boolean
  onClose: () => void
  onJoin: (code: string) => void
  busy?: boolean
  /**
   * Popup arka planı. Ana sayfada `light` kullanılır; koyu arka plan
   * "ekran karardı/siyah oldu" hissi veriyordu.
   */
  backdrop?: 'dim' | 'light'
}

const CODE_LENGTH = 6
// Sunucudaki `duo_create_room` ile aynı alfabe: karışıklığa yol açan
// I, O, 0 ve 1 hariç tutulur. Girişi buna göre doğrularız.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`)
const sanitize = (value: string) =>
  value
    .toUpperCase()
    .split('')
    .filter((char) => CODE_ALPHABET.includes(char))
    .join('')
    .slice(0, CODE_LENGTH)

/**
 * In-app room-code entry dialog. Replaces the native `window.prompt` so the
 * join flow matches the rest of the UI.
 */
export function JoinDialog({ open, onClose, onJoin, busy, backdrop = 'dim' }: Props) {
  const { t } = useI18n()
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
      title={t('Join a game')}
      subtitle={t('Enter the 6-character code your friend shared.')}
      onClose={onClose}
      backdrop={backdrop}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button onClick={submit} disabled={busy || !valid}>
            {busy ? t('Joining…') : t('🔗 Join game')}
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
          <span className="field-label">{t('Room code')}</span>
          <input
            ref={inputRef}
            data-autofocus
            className={['code-input', showError ? 'invalid' : ''].filter(Boolean).join(' ')}
            value={code}
            onChange={(event) => {
              setCode(sanitize(event.target.value))
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
            {t('Codes are 6 characters (letters/numbers, e.g. ABC234). Letters I, O and digits 0, 1 are not used.')}
          </p>
        )}
      </form>
    </Modal>
  )
}
