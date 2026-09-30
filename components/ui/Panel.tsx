'use client'

import type { ReactNode } from 'react'

type Props = {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}

export function Panel({ title, subtitle, actions, className, children }: Props) {
  return (
    <section className={['panel', className].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}
