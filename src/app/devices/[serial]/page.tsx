'use client'

import { use, useState, useEffect } from 'react'
import Link from 'next/link'
import NavHeader from '@/components/NavHeader'
import { buildCameraLinks } from '../helpers'
import styles from './page.module.css'

type Camera = {
  channelNo: number
  channelName: string
}

export default function CameraListPage({ params }: { params: Promise<{ serial: string }> }) {
  const { serial } = use(params)
  const [cameras, setCameras] = useState<Camera[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`/api/devices/${serial}/cameras`)
      .then(res => res.json())
      .then(data => setCameras(data.cameras ?? []))
      .catch(() => setError('Failed to load cameras'))
  }, [serial])

  return (
    <>
      <NavHeader crumbs={[{ label: 'Devices', href: '/devices' }, { label: serial }]} />
      <div className={styles.container}>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.grid}>
          {cameras.map(c => {
            const links = buildCameraLinks(serial, c.channelNo)
            return (
              <div key={c.channelNo} className={styles.card}>
                <div className={styles.name}>{c.channelName}</div>
                <div className={styles.channel}>Ch {c.channelNo}</div>
                <div className={styles.links}>
                  <Link href={links.live} className={styles.liveLink}>Live View</Link>
                  <Link href={links.playback} className={styles.playbackLink}>Playback</Link>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
