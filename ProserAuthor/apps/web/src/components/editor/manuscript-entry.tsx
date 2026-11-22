'use client';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { getAuthoringDocumentCapabilities } from '@/lib/document-api';
import { Button } from '@/components/ui/button';
import { ManuscriptWorkspace } from './manuscript-workspace';

/** Capability negotiation runs before mounting a writer or loading scene prose. */
export function ManuscriptEntry() {
  const { data: session } = useSession();
  if (!session?.user?.id) return <p role="status">Authenticate to open your manuscript.</p>;
  return <OwnedManuscript key={session.user.id} />;
}
function OwnedManuscript() {
  const [capability, setCapability] = useState<{ enabled: boolean; schemaVersion: number }>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCapability(undefined);
    setError(undefined);
    void getAuthoringDocumentCapabilities(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          value.enabled &&
          (value.schemaVersion !== 1 ||
            value.orderedPassages !== 'ordered-window-v1' ||
            value.passageOperations !== 'typed-operations-v1')
        )
          throw new Error('Factory advertises an unsupported document schema.');
        setCapability(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : 'Unable to read document capabilities.',
          );
      });
    return () => controller.abort();
  }, [reload]);
  if (error)
    return (
      <section role="alert">
        <p>{error}</p>
        <Button type="button" onClick={() => setReload((value) => value + 1)}>
          Retry capabilities
        </Button>
      </section>
    );
  if (!capability) return <p role="status">Loading manuscript capabilities…</p>;
  return capability.enabled ? (
    <ManuscriptWorkspace />
  ) : (
    <section role="alert">
      <p>Manuscript editing is unavailable while Factory document authority is inactive.</p>
      <Button type="button" onClick={() => setReload((value) => value + 1)}>
        Check document availability
      </Button>
    </section>
  );
}
