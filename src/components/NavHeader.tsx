'use client'

import Link from 'next/link'
import styles from './NavHeader.module.css'

export type Crumb = { label: string; href?: string }

type FormattedCrumb = {
  label: string
  href?: string
  isCurrent: boolean
  isLink: boolean
  separator?: string
}

export function formatCrumbs(crumbs: Crumb[]): FormattedCrumb[] {
  return crumbs.map((crumb, i) => {
    const isLast = i === crumbs.length - 1
    return {
      label: crumb.label,
      href: crumb.href,
      isCurrent: isLast && !crumb.href,
      isLink: !!crumb.href,
      separator: isLast ? undefined : '›',
    }
  })
}

export default function NavHeader({ crumbs }: { crumbs: Crumb[] }) {
  const items = formatCrumbs(crumbs)

  return (
    <nav className={styles.header}>
      <div className={styles.crumbs}>
        {items.map((item, i) => (
          <span key={i}>
            {item.isLink ? (
              <Link href={item.href!} className={styles.link}>{item.label}</Link>
            ) : (
              <span className={styles.current}>{item.label}</span>
            )}
            {item.separator && <span className={styles.separator}>{item.separator}</span>}
          </span>
        ))}
      </div>
      <Link href="/" className={styles.logout}>Logout</Link>
    </nav>
  )
}
