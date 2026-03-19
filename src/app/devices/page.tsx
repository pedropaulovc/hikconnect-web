'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import NavHeader from '@/components/NavHeader'
import { isDeviceOnline } from './helpers'
import styles from './page.module.css'

type Device = {
  deviceSerial: string
  deviceName: string
  status: number
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/devices')
      .then(res => res.json())
      .then(data => setDevices(data.devices ?? []))
      .catch(() => setError('Failed to load devices'))
  }, [])

  return (
    <>
      <NavHeader crumbs={[{ label: 'Devices' }]} />
      <div className={styles.container}>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.grid}>
          {devices.map(d => (
            <Link key={d.deviceSerial} href={`/devices/${d.deviceSerial}`} className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={`${styles.dot} ${isDeviceOnline(d.status) ? styles.online : styles.offline}`} />
                <span>{d.deviceName}</span>
              </div>
              <div className={styles.serial}>{d.deviceSerial}</div>
            </Link>
          ))}
        </div>
      </div>
    </>
  )
}
