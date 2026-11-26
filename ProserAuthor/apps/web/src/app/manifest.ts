import type { MetadataRoute } from 'next';

/** Lets phones and desktops install Proser; it opens on the mobile home with Quick Draft. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Proser',
    short_name: 'Proser',
    description: 'A writing studio for long-form fiction.',
    id: '/m',
    start_url: '/m',
    scope: '/',
    display: 'standalone',
    background_color: '#0b0b10',
    theme_color: '#6d28d9',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
