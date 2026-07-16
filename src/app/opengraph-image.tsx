import { ImageResponse } from 'next/og'

export const alt = 'HopIt: Your code, already there'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        alignItems: 'center',
        background: 'linear-gradient(135deg, #f8fafc 0%, #eef6ff 55%, #eaf8ef 100%)',
        color: '#20242a',
        display: 'flex',
        height: '100%',
        justifyContent: 'center',
        padding: '72px',
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 34, maxWidth: 980, width: '100%' }}>
        <div style={{ alignItems: 'center', display: 'flex', fontSize: 34, fontWeight: 700, gap: 18 }}>
          <div
            style={{
              alignItems: 'center',
              background: '#1f8a3b',
              borderRadius: 14,
              color: 'white',
              display: 'flex',
              fontSize: 34,
              height: 64,
              justifyContent: 'center',
              width: 64,
            }}
          >
            ↗
          </div>
          HopIt
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', fontSize: 78, fontWeight: 800, letterSpacing: '-4px', lineHeight: 1.03 }}>
          <span>Your code,</span>
          <span style={{ color: '#1f8a3b' }}>already there.</span>
        </div>
        <div style={{ color: '#65707d', display: 'flex', fontSize: 30, lineHeight: 1.45 }}>
          Cloud-native code workspaces that stay synchronized across every device.
        </div>
      </div>
    </div>,
    size,
  )
}
