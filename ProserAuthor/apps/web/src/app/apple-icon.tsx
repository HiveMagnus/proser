import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/** Home-screen icon for iOS, which does not use SVG icons. */
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
        color: '#ffffff',
        fontSize: 112,
        fontWeight: 700,
        fontFamily: 'serif',
      }}
    >
      P
    </div>,
    size,
  );
}
