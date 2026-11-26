'use client';

import { useCallback, useEffect, useState } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { User, Cpu, Loader2, LogOut, PenTool, RefreshCw, Save, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';

interface InferenceModel {
  id: string;
  name: string;
}

interface PageSettings {
  profile: {
    displayName: string;
  };
  writing: {
    defaultGenre: string;
    writingStyle: string;
    targetAudience: string;
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

async function getResponseErrorMessage(res: Response, fallback: string) {
  try {
    const json = (await res.json()) as { error?: string | { message?: string } };
    const error = json.error;
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
    if (
      error &&
      typeof error === 'object' &&
      typeof error.message === 'string' &&
      error.message.trim()
    ) {
      return error.message;
    }
  } catch {
    // Ignore malformed error payloads and fall back to the default message.
  }
  return fallback;
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // ── Profile state ──
  const [displayName, setDisplayName] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [sessionsRevoking, setSessionsRevoking] = useState(false);
  const [sessionsError, setSessionsError] = useState('');

  // ── AI Config state ──
  const [inferenceUrl, setInferenceUrl] = useState('http://127.0.0.1:8000');
  const [defaultModel, setDefaultModel] = useState('qwen3.6-35b');
  const [availableModels, setAvailableModels] = useState<InferenceModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'testing' | 'connected' | 'failed'
  >('idle');

  // ── Writing Preferences state ──
  const [defaultGenre, setDefaultGenre] = useState('');
  const [writingStyle, setWritingStyle] = useState('');
  const [targetAudience, setTargetAudience] = useState('');
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);
  const [prefsError, setPrefsError] = useState('');

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const json = (await res.json()) as { data?: PageSettings };
        setDisplayName(json.data?.profile?.displayName || '');
        setDefaultGenre(json.data?.writing?.defaultGenre || '');
        setWritingStyle(json.data?.writing?.writingStyle || '');
        setTargetAudience(json.data?.writing?.targetAudience || '');
      }
    } catch {
      /* ignore */
    } finally {
      setSettingsLoaded(true);
    }
  }, []);

  const loadInferenceSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/models/settings');
      if (res.ok) {
        const json = await res.json();
        const host = typeof json.data?.host === 'string' ? json.data.host : null;
        const model = typeof json.data?.model === 'string' ? json.data.model : null;
        if (host) setInferenceUrl(host);
        if (model) setDefaultModel(model);
        return { host, model };
      }
    } catch {
      /* ignore */
    }
    return null;
  }, []);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError('');
    try {
      const res = await fetch('/api/models');
      if (!res.ok) {
        throw new Error(
          await getResponseErrorMessage(
            res,
            'Could not load models from the selected inference host.',
          ),
        );
      }
      const json = (await res.json()) as { data?: InferenceModel[] };
      const models = Array.isArray(json.data) ? json.data : [];
      setAvailableModels(models);
      if (models.length === 0) {
        setModelsError('The host responded, but it did not return any models.');
      }
    } catch (error) {
      setAvailableModels([]);
      setModelsError(
        getErrorMessage(error, 'Could not load models from the selected inference host.'),
      );
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!settingsLoaded) {
      void loadSettings();
    }
  }, [loadSettings, settingsLoaded]);

  useEffect(() => {
    void (async () => {
      await loadInferenceSettings();
      await loadModels();
    })();
  }, [loadInferenceSettings, loadModels]);

  async function handleRevokeSessions() {
    setSessionsRevoking(true);
    setSessionsError('');
    try {
      const res = await fetch('/api/settings/sessions/revoke', { method: 'POST' });
      if (!res.ok) {
        throw new Error(await getResponseErrorMessage(res, 'Sessions could not be signed out.'));
      }
      await signOut({ callbackUrl: '/auth/signin' });
    } catch (error) {
      setSessionsError(getErrorMessage(error, 'Sessions could not be signed out.'));
      setSessionsRevoking(false);
    }
  }

  async function handleSaveProfile() {
    setProfileSaving(true);
    setProfileError('');
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: { displayName } }),
      });
      if (!res.ok) {
        throw new Error(await getResponseErrorMessage(res, 'Profile settings could not be saved.'));
      }
      await loadSettings();
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2000);
    } catch (error) {
      setProfileError(getErrorMessage(error, 'Profile settings could not be saved.'));
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleTestConnection() {
    setConnectionStatus('testing');
    setModelsError('');
    try {
      const res = await fetch('/api/models/status', { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const json = await res.json();
        setConnectionStatus(json.data?.connected ? 'connected' : 'failed');
        if (json.data?.connected) {
          await loadInferenceSettings();
          await loadModels();
        } else if (typeof json.data?.error === 'string' && json.data.error.trim()) {
          setModelsError(json.data.error);
        }
      } else {
        setConnectionStatus('failed');
        setModelsError(
          await getResponseErrorMessage(res, 'Could not connect to the selected inference host.'),
        );
      }
    } catch (error) {
      setConnectionStatus('failed');
      setModelsError(getErrorMessage(error, 'Could not connect to the selected inference host.'));
    }
  }

  async function handleSavePreferences() {
    setPrefsSaving(true);
    setPrefsError('');
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writing: { defaultGenre, writingStyle, targetAudience } }),
      });
      if (!res.ok) {
        throw new Error(
          await getResponseErrorMessage(res, 'Writing preferences could not be saved.'),
        );
      }
      await loadSettings();
      setPrefsSaved(true);
      setTimeout(() => setPrefsSaved(false), 2000);
    } catch (error) {
      setPrefsError(getErrorMessage(error, 'Writing preferences could not be saved.'));
    } finally {
      setPrefsSaving(false);
    }
  }

  return (
    <div className="space-y-6 animate-[fade-in_400ms_var(--ease-out-expo)]">
      <div>
        <h1 className="font-[--font-display] text-[length:--text-3xl] font-bold tracking-tight text-text-primary">
          Settings
        </h1>
        <p className="mt-1 text-[length:--text-sm] text-text-secondary">
          Configure your writing environment and AI connections.
        </p>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">
            <User className="mr-1.5 size-4" />
            Profile
          </TabsTrigger>
          <TabsTrigger value="ai">
            <Cpu className="mr-1.5 size-4" />
            AI Config
          </TabsTrigger>
          <TabsTrigger value="writing">
            <PenTool className="mr-1.5 size-4" />
            Writing
          </TabsTrigger>
        </TabsList>

        {/* ── Profile Tab ──────────────────── */}
        <TabsContent value="profile" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>User Profile</CardTitle>
              <CardDescription>Your account details and preferences.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-[length:--text-sm] font-medium text-text-primary">
                  Display Name
                </label>
                <Input
                  className="mt-1.5"
                  placeholder="Your name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[length:--text-sm] font-medium text-text-primary">
                  Email
                </label>
                <Input
                  className="mt-1.5"
                  placeholder="you@example.com"
                  value={session?.user?.email ?? ''}
                  disabled
                />
              </div>
              <div className="flex items-center justify-end gap-3 pt-2">
                {profileSaved && (
                  <span
                    className="flex items-center gap-1 text-[length:--text-sm] text-green-400"
                    aria-live="polite"
                  >
                    <CheckCircle2 className="size-4" /> Saved
                  </span>
                )}
                <Button onClick={handleSaveProfile} disabled={profileSaving}>
                  {profileSaving ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 size-4" />
                  )}
                  Save Profile
                </Button>
              </div>
              {profileError ? (
                <p className="text-[length:--text-sm] text-red-300" role="alert">
                  {profileError}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sessions</CardTitle>
              <CardDescription>
                Sign out of every browser and device, including this one. Use this if a device is
                lost or you think someone else has access.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-end">
                <Button
                  variant="secondary"
                  onClick={handleRevokeSessions}
                  disabled={sessionsRevoking}
                >
                  {sessionsRevoking ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <LogOut className="mr-2 size-4" />
                  )}
                  Sign out everywhere
                </Button>
              </div>
              {sessionsError ? (
                <p className="text-[length:--text-sm] text-red-300" role="alert">
                  {sessionsError}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── AI Config Tab ────────────────── */}
        <TabsContent value="ai" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Inference Connection</CardTitle>
              <CardDescription>
                Runtime-owned ProserFactory model configuration. Operators change this on the
                Factory service.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-[length:--text-sm] font-medium text-text-primary">
                  Host URL
                </label>
                <Input
                  className="mt-1.5"
                  placeholder="http://127.0.0.1:8000"
                  value={inferenceUrl}
                  disabled
                />
              </div>
              <div>
                <label className="text-[length:--text-sm] font-medium text-text-primary">
                  Default Model
                </label>
                <Input className="mt-1.5" value={defaultModel} disabled />
                {availableModels.length > 0 ? (
                  <p className="mt-1 text-[length:--text-xs] text-text-muted">
                    {availableModels.length} model{availableModels.length === 1 ? '' : 's'} reported
                    by Factory.
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <Button
                  variant="secondary"
                  onClick={handleTestConnection}
                  disabled={connectionStatus === 'testing'}
                >
                  {connectionStatus === 'testing' && (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  )}
                  Test Connection
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void loadModels();
                  }}
                  disabled={modelsLoading}
                >
                  {modelsLoading ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 size-4" />
                  )}
                  Refresh Models
                </Button>
                {connectionStatus === 'connected' && <Badge variant="success">Connected</Badge>}
                {connectionStatus === 'failed' && <Badge variant="danger">Connection Failed</Badge>}
              </div>
              {modelsError ? (
                <p className="text-[length:--text-sm] text-amber-300" role="status">
                  {modelsError}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Writing Tab ──────────────────── */}
        <TabsContent value="writing" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Writing Preferences</CardTitle>
              <CardDescription>Defaults for new projects and AI generation.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-[length:--text-sm] font-medium text-text-primary">
                  Default Genre
                </label>
                <Select value={defaultGenre} onValueChange={setDefaultGenre}>
                  <SelectTrigger className="mt-1.5">
                    <SelectValue placeholder="Select default genre" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fantasy">Fantasy</SelectItem>
                    <SelectItem value="sci-fi">Sci-Fi</SelectItem>
                    <SelectItem value="thriller">Thriller</SelectItem>
                    <SelectItem value="romance">Romance</SelectItem>
                    <SelectItem value="literary">Literary Fiction</SelectItem>
                    <SelectItem value="mystery">Mystery</SelectItem>
                    <SelectItem value="horror">Horror</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[length:--text-sm] font-medium text-text-primary">
                  Default Writing Style
                </label>
                <Textarea
                  className="mt-1.5"
                  rows={3}
                  placeholder="Describe your preferred writing style..."
                  value={writingStyle}
                  onChange={(e) => setWritingStyle(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[length:--text-sm] font-medium text-text-primary">
                  Target Audience
                </label>
                <Select value={targetAudience} onValueChange={setTargetAudience}>
                  <SelectTrigger className="mt-1.5">
                    <SelectValue placeholder="Select target audience" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ya">Young Adult</SelectItem>
                    <SelectItem value="adult">Adult</SelectItem>
                    <SelectItem value="na">New Adult</SelectItem>
                    <SelectItem value="middle-grade">Middle Grade</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-end gap-3 pt-2">
                {prefsSaved && (
                  <span
                    className="flex items-center gap-1 text-[length:--text-sm] text-green-400"
                    aria-live="polite"
                  >
                    <CheckCircle2 className="size-4" /> Saved
                  </span>
                )}
                <Button onClick={handleSavePreferences} disabled={prefsSaving}>
                  {prefsSaving ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 size-4" />
                  )}
                  Save Preferences
                </Button>
              </div>
              {prefsError ? (
                <p className="text-[length:--text-sm] text-red-300" role="alert">
                  {prefsError}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
