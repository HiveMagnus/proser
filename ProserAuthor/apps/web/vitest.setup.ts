import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement matchMedia — simulate prefers-reduced-motion to disable animations in tests.
// Suites that opt into the node environment (server-side auth flows) have no window.
if (typeof window !== 'undefined')
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
