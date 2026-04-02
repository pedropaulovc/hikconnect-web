'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './page.module.css'

export default function LoginPage() {
  const router = useRouter()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const form = new FormData(e.currentTarget)
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        account: form.get('account'),
        password: form.get('password'),
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    setLoading(false)
    if (!res.ok) {
      setError(data.error)
      return
    }
    router.push('/devices')
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>HikConnect Web</h1>
      <form onSubmit={handleSubmit}>
        <div className={styles.field}>
          <input name="account" placeholder="Email / Username" required className={styles.input} />
        </div>
        <div className={styles.field}>
          <input name="password" type="password" placeholder="Password" required className={styles.input} />
        </div>
        <button type="submit" disabled={loading} className={styles.button}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
        {error && <p className={styles.error}>{error}</p>}
      </form>
    </div>
  )
}
