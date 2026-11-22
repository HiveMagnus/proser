'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0d0d0f',
          color: '#e2e2e6',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          margin: 0,
          padding: '1rem',
        }}
      >
        <div style={{ maxWidth: '24rem', textAlign: 'center' }}>
          <div
            style={{
              width: '4rem',
              height: '4rem',
              margin: '0 auto 1.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '1rem',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              fontSize: '2rem',
            }}
          >
            ⚠
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0 0 0.5rem' }}>
            Something went wrong
          </h2>
          <p style={{ fontSize: '0.875rem', color: '#9b9ba4', margin: '0 0 0.25rem' }}>
            An unexpected error prevented this page from loading.
          </p>
          {error.digest && (
            <p
              style={{
                fontSize: '0.75rem',
                color: '#6b6b74',
                fontFamily: 'monospace',
                margin: '0 0 1.5rem',
              }}
            >
              Error ID: {error.digest}
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button
              onClick={reset}
              type="button"
              style={{
                padding: '0.5rem 1rem',
                borderRadius: '0.5rem',
                border: '1px solid #333',
                backgroundColor: '#1a1a1f',
                color: '#e2e2e6',
                fontSize: '0.875rem',
                cursor: 'pointer',
              }}
            >
              Try Again
            </button>
            <a
              href="/auth/signin"
              style={{
                padding: '0.5rem 1rem',
                borderRadius: '0.5rem',
                border: '1px solid #333',
                backgroundColor: 'transparent',
                color: '#9b9ba4',
                fontSize: '0.875rem',
                textDecoration: 'none',
              }}
            >
              Sign In
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
