'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';

export type Surface =
  | 'dashboard'
  | 'manuscript'
  | 'bible'
  | 'plot'
  | 'continuity'
  | 'quality'
  | 'publish'
  | 'workflows'
  | 'settings';

export interface WorkspaceState {
  activeBookId: string | null;
  activeBookTitle: string | null;
  activeSceneId: string | null;
  activeSurface: Surface;
  lastVisitedAt: string | null;
}

interface WorkspaceActions {
  setActiveBook: (bookId: string | null, bookTitle?: string | null) => void;
  setActiveBookId: (bookId: string | null) => void;
  setActiveBookTitle: (title: string | null) => void;
  setActiveScene: (sceneId: string | null) => void;
  setActiveSceneId: (sceneId: string | null) => void;
  setActiveSurface: (surface: Surface) => void;
}

type WorkspaceCtx = WorkspaceState & WorkspaceActions;

export const workspaceStorageKey = (userId: string) =>
  JSON.stringify(['proser-workspace-v1', userId]);

function loadFromStorage(userId: string): Partial<WorkspaceState> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(workspaceStorageKey(userId));
    if (!raw) return {};
    const record = JSON.parse(raw) as {
      schemaVersion?: number;
      userId?: string;
      state?: Partial<WorkspaceState>;
    };
    return record.schemaVersion === 1 && record.userId === userId ? (record.state ?? {}) : {};
  } catch {
    return {};
  }
}

function saveToStorage(userId: string, state: WorkspaceState) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      workspaceStorageKey(userId),
      JSON.stringify({ schemaVersion: 1, userId, state }),
    );
  } catch {
    // quota exceeded — ignore
  }
}

const defaults: WorkspaceState = {
  activeBookId: null,
  activeBookTitle: null,
  activeSceneId: null,
  activeSurface: 'dashboard',
  lastVisitedAt: null,
};

const WorkspaceContext = React.createContext<WorkspaceCtx | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return (
    <OwnedWorkspaceProvider key={userId ?? 'anonymous'} userId={userId}>
      {children}
    </OwnedWorkspaceProvider>
  );
}
function OwnedWorkspaceProvider({
  children,
  userId,
}: {
  children: React.ReactNode;
  userId?: string;
}) {
  const [state, setState] = React.useState<WorkspaceState>(defaults);
  const [storageLoaded, setStorageLoaded] = React.useState(false);

  React.useEffect(() => {
    setState((current) => ({ ...current, ...(userId ? loadFromStorage(userId) : {}) }));
    setStorageLoaded(true);
  }, [userId]);

  React.useEffect(() => {
    if (storageLoaded && userId) saveToStorage(userId, state);
  }, [state, storageLoaded, userId]);

  const setActiveBook = React.useCallback((bookId: string | null, bookTitle?: string | null) => {
    setState((prev) => ({
      ...prev,
      activeBookId: bookId,
      activeBookTitle:
        bookTitle !== undefined
          ? bookTitle
          : bookId === prev.activeBookId
            ? prev.activeBookTitle
            : null,
      activeSceneId: bookId !== prev.activeBookId ? null : prev.activeSceneId,
      lastVisitedAt: new Date().toISOString(),
    }));
  }, []);

  const setActiveBookId = React.useCallback((bookId: string | null) => {
    setState((prev) => ({
      ...prev,
      activeBookId: bookId,
      activeBookTitle: bookId === prev.activeBookId ? prev.activeBookTitle : null,
      activeSceneId: bookId !== prev.activeBookId ? null : prev.activeSceneId,
      lastVisitedAt: new Date().toISOString(),
    }));
  }, []);

  const setActiveBookTitle = React.useCallback((title: string | null) => {
    setState((prev) => ({
      ...prev,
      activeBookTitle: title,
    }));
  }, []);

  const setActiveScene = React.useCallback((sceneId: string | null) => {
    setState((prev) => ({
      ...prev,
      activeSceneId: sceneId,
      lastVisitedAt: new Date().toISOString(),
    }));
  }, []);

  const setActiveSceneId = setActiveScene;

  const setActiveSurface = React.useCallback((surface: Surface) => {
    setState((prev) => ({
      ...prev,
      activeSurface: surface,
      lastVisitedAt: new Date().toISOString(),
    }));
  }, []);

  const value = React.useMemo<WorkspaceCtx>(
    () => ({
      ...state,
      setActiveBook,
      setActiveBookId,
      setActiveBookTitle,
      setActiveScene,
      setActiveSceneId,
      setActiveSurface,
    }),
    [
      state,
      setActiveBook,
      setActiveBookId,
      setActiveBookTitle,
      setActiveScene,
      setActiveSceneId,
      setActiveSurface,
    ],
  );

  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}

export function useWorkspace(): WorkspaceCtx {
  const ctx = React.useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}
