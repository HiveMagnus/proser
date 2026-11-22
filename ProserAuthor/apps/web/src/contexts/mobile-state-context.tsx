'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';

import type { MobileViewPreference } from '@/lib/mobile-routing';

export const mobileStateStorageKey = (userId: string) =>
  JSON.stringify(['proser-mobile-state-v1', userId]);

export interface MobileState {
  shellPreference: MobileViewPreference;
  lastBookId: string | null;
  lastSceneId: string | null;
  activeTraceId: string | null;
  draftBrief: string;
  pendingCommand: string;
}

interface MobileStateActions {
  setShellPreference: (value: MobileViewPreference) => void;
  setLastDraftTarget: (bookId: string | null, sceneId: string | null) => void;
  setActiveTraceId: (traceId: string | null) => void;
  setDraftBrief: (value: string) => void;
  setPendingCommand: (value: string) => void;
  resetTransientState: () => void;
}

type MobileStateContextValue = MobileState & MobileStateActions;

const defaults: MobileState = {
  shellPreference: 'auto',
  lastBookId: null,
  lastSceneId: null,
  activeTraceId: null,
  draftBrief: '',
  pendingCommand: '',
};

const MobileStateContext = React.createContext<MobileStateContextValue | null>(null);

function loadState(userId?: string): MobileState {
  if (typeof window === 'undefined' || !userId) return defaults;
  try {
    const raw = window.localStorage.getItem(mobileStateStorageKey(userId));
    if (!raw) return defaults;
    const record = JSON.parse(raw) as {
      schemaVersion?: number;
      userId?: string;
      state?: Partial<MobileState>;
    };
    return record.schemaVersion === 1 && record.userId === userId
      ? { ...defaults, ...record.state }
      : defaults;
  } catch {
    return defaults;
  }
}

export function MobileStateProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return (
    <OwnedMobileStateProvider key={userId ?? 'anonymous'} userId={userId}>
      {children}
    </OwnedMobileStateProvider>
  );
}
function OwnedMobileStateProvider({
  children,
  userId,
}: {
  children: React.ReactNode;
  userId?: string;
}) {
  const [state, setState] = React.useState<MobileState>(() => loadState(userId));

  React.useEffect(() => {
    if (!userId) return;
    try {
      window.localStorage.setItem(
        mobileStateStorageKey(userId),
        JSON.stringify({ schemaVersion: 1, userId, state }),
      );
    } catch {
      // ignore quota errors
    }
  }, [state, userId]);

  const setShellPreference = React.useCallback<MobileStateActions['setShellPreference']>(
    (shellPreference) => setState((prev) => ({ ...prev, shellPreference })),
    [],
  );
  const setLastDraftTarget = React.useCallback<MobileStateActions['setLastDraftTarget']>(
    (lastBookId, lastSceneId) => setState((prev) => ({ ...prev, lastBookId, lastSceneId })),
    [],
  );
  const setActiveTraceId = React.useCallback<MobileStateActions['setActiveTraceId']>(
    (activeTraceId) => setState((prev) => ({ ...prev, activeTraceId })),
    [],
  );
  const setDraftBrief = React.useCallback<MobileStateActions['setDraftBrief']>(
    (draftBrief) => setState((prev) => ({ ...prev, draftBrief })),
    [],
  );
  const setPendingCommand = React.useCallback<MobileStateActions['setPendingCommand']>(
    (pendingCommand) => setState((prev) => ({ ...prev, pendingCommand })),
    [],
  );
  const resetTransientState = React.useCallback<MobileStateActions['resetTransientState']>(
    () =>
      setState((prev) => ({ ...prev, activeTraceId: null, draftBrief: '', pendingCommand: '' })),
    [],
  );

  const value = React.useMemo<MobileStateContextValue>(
    () => ({
      ...state,
      setShellPreference,
      setLastDraftTarget,
      setActiveTraceId,
      setDraftBrief,
      setPendingCommand,
      resetTransientState,
    }),
    [
      state,
      setShellPreference,
      setLastDraftTarget,
      setActiveTraceId,
      setDraftBrief,
      setPendingCommand,
      resetTransientState,
    ],
  );

  return <MobileStateContext.Provider value={value}>{children}</MobileStateContext.Provider>;
}

export function useMobileState() {
  const context = React.useContext(MobileStateContext);
  if (!context) {
    throw new Error('useMobileState must be used within MobileStateProvider');
  }
  return context;
}
