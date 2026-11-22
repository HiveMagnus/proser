export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // Auth pages bypass the AppShell — no sidebar, no top bar
  return <>{children}</>;
}
