'use client'

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { playSound, unlockAudio } from '../../lib/sound'

type Variant = 'primary' | 'ghost' | 'danger' | 'soft'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  children: ReactNode
}

const VARIANTS: Record<Variant, string> = {
  primary: 'btn btn-primary',
  ghost: 'btn btn-ghost',
  danger: 'btn btn-danger',
  soft: 'btn btn-soft',
}

export function Button({ variant = 'primary', className, onClick, children, ...rest }: Props) {
  return (
    <button
      {...rest}
      className={[VARIANTS[variant], className].filter(Boolean).join(' ')}
      onClick={(event) => {
        unlockAudio()
        playSound('click')
        onClick?.(event)
      }}
    >
      {children}
    </button>
  )
}
