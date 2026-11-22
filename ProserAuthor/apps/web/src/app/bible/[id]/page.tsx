'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';
import {
  ArrowLeft,
  Save,
  Trash2,
  Plus,
  Users,
  MapPin,
  Sword,
  Crown,
  Calendar,
  ScrollText,
  X,
  Loader2,
  CheckCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { getCodexEntry, updateCodexEntry, deleteCodexEntry } from '@/lib/api';

// Same demo data as bible list page — used for readonly preview
const demoEntries: Record<
  string,
  { name: string; type: string; desc: string; attrs: string | null }
> = {
  'demo-1': {
    name: 'Kael Ashborne',
    type: 'character',
    desc: 'Exiled prince of the Sunfire dynasty. Carries a curse that turns his blood to molten gold.',
    attrs: '{"role":"Protagonist","age":"28"}',
  },
  'demo-2': {
    name: 'Sera Voss',
    type: 'character',
    desc: 'Shadow operative for the Glass Court. Unmatched in deception and knife-work.',
    attrs: '{"role":"Deuteragonist","age":"25"}',
  },
  'demo-3': {
    name: 'The Hollow Citadel',
    type: 'location',
    desc: 'A floating fortress suspended above the Abyssal Rift. Seat of the Voidborn Council.',
    attrs: null,
  },
  'demo-4': {
    name: 'The Glass Court',
    type: 'faction',
    desc: 'An ancient order of spies and diplomats operating from behind the politics of every nation.',
    attrs: null,
  },
  'demo-5': {
    name: 'Sunfire Crown',
    type: 'item',
    desc: 'The ancestral crown of the Ashborne dynasty. Burns any unworthy wearer to ash.',
    attrs: null,
  },
  'demo-6': {
    name: 'Kael ↔ Sera — Reluctant Alliance',
    type: 'relationship',
    desc: 'Bound by necessity after the fall of the Sunfire dynasty. Neither fully trusts the other.',
    attrs: '{"type":"Alliance","tension":"High"}',
  },
  'demo-7': {
    name: 'The Glass Court → Kael — Surveillance',
    type: 'relationship',
    desc: 'The Glass Court monitors Kael as a potential asset or threat to their influence.',
    attrs: '{"type":"Surveillance"}',
  },
  'demo-8': {
    name: 'The Sunfire Bloodline Curse',
    type: 'rule',
    desc: 'Any Ashborne heir who renounces the throne will see their blood transmute to molten gold over time, eventually killing them.',
    attrs: '{"certainty":"Established"}',
  },
  'demo-9': {
    name: 'Abyssal Rift Gravity Anomaly',
    type: 'rule',
    desc: 'Objects and structures near the Rift experience inverted or reduced gravity, enabling the Citadel to float.',
    attrs: '{"certainty":"Established"}',
  },
  'demo-10': {
    name: 'The Fall of the Sunfire Dynasty',
    type: 'event',
    desc: 'The burning throne room — the Ashborne dynasty is destroyed in a single night of fire and betrayal.',
    attrs: '{"scene":"The burning throne room"}',
  },
  'demo-11': {
    name: "Kael's Exile Begins",
    type: 'event',
    desc: 'Kael flees through the tunnels beneath the palace, choosing survival over the crown.',
    attrs: '{"scene":"Flight through the tunnels"}',
  },
  'demo-12': {
    name: 'Arrival at Valeport',
    type: 'event',
    desc: 'Kael docks at Valeport under a false name and begins planning his return.',
    attrs: '{"scene":"Docking at Valeport"}',
  },
};

const entryTypeIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  character: Users,
  location: MapPin,
  lore: ScrollText,
  item: Sword,
  faction: Crown,
  event: Calendar,
  rule: ScrollText,
};

const ENTRY_TYPES = [
  'character',
  'location',
  'lore',
  'item',
  'faction',
  'event',
  'rule',
  'culture',
  'relationship',
] as const;

function parseAttributes(attrs: string | null): Record<string, string> {
  if (!attrs) return {};
  try {
    return JSON.parse(attrs);
  } catch {
    return {};
  }
}

export default function CodexEntryPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const entryId = params.id as string;
  const bookId = searchParams.get('bookId') ?? '';
  const isReadonly = searchParams.get('readonly') === '1' || bookId === 'demo';

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [entryName, setEntryName] = useState('');
  const [entryType, setEntryType] = useState('character');
  const [entryDescription, setEntryDescription] = useState('');
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [newAttrKey, setNewAttrKey] = useState('');
  const [newAttrValue, setNewAttrValue] = useState('');

  // Load entry
  useEffect(() => {
    if (!bookId || !entryId) {
      setError('Missing bookId parameter');
      setLoading(false);
      return;
    }

    // Handle demo entries (readonly preview)
    if (isReadonly && entryId.startsWith('demo-')) {
      const demo = demoEntries[entryId];
      if (demo) {
        setEntryName(demo.name);
        setEntryType(demo.type);
        setEntryDescription(demo.desc);
        setAttributes(parseAttributes(demo.attrs));
      } else {
        setError('Demo entry not found');
      }
      setLoading(false);
      return;
    }

    let cancelled = false;
    getCodexEntry(bookId, entryId)
      .then((res) => {
        if (cancelled) return;
        const e = res.data;
        setEntryName(e.entryName);
        setEntryType(e.entryType);
        setEntryDescription(e.entryDescription ?? '');
        setAttributes(parseAttributes(e.attributes));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, entryId, isReadonly]);

  const Icon = entryTypeIcons[entryType] ?? ScrollText;

  const addAttribute = () => {
    if (!newAttrKey.trim()) return;
    setAttributes((prev) => ({ ...prev, [newAttrKey]: newAttrValue }));
    setNewAttrKey('');
    setNewAttrValue('');
  };

  const removeAttribute = (key: string) => {
    setAttributes((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleSave = async () => {
    if (!bookId) return;
    setSaving(true);
    setSaved(false);
    try {
      await updateCodexEntry(bookId, entryId, {
        entryName,
        entryType,
        entryDescription: entryDescription || undefined,
        attributes: Object.keys(attributes).length > 0 ? JSON.stringify(attributes) : undefined,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!bookId || !confirm('Delete this entry? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await deleteCodexEntry(bookId, entryId);
      router.push('/bible');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-text-muted">
        <Loader2 className="size-6 animate-spin mr-2" />
        Loading entry...
      </div>
    );
  }

  if (error && !entryName) {
    return (
      <div className="space-y-4 py-12 text-center">
        <p className="text-text-secondary">{error}</p>
        <Button variant="secondary" onClick={() => router.push('/bible')}>
          <ArrowLeft className="mr-2 size-4" />
          Back to Bible
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-[fade-in_400ms_var(--ease-out-expo)]">
      {isReadonly && (
        <div className="rounded-[--radius-md] border border-warning/30 bg-warning/5 px-4 py-3 text-[length:--text-sm] text-warning">
          Viewing demo data — create a book and add entries to start editing your own world.
        </div>
      )}
      {/* ── Header ─────────────────────────── */}
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          <button
            onClick={() => router.push('/bible')}
            className="mt-1 rounded-[--radius-md] p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div>
            <div className="flex items-center gap-3 mb-1">
              <div className="flex size-9 items-center justify-center rounded-[--radius-md] bg-accent-500/10">
                <Icon className="size-4 text-accent-400" />
              </div>
              <Badge variant="accent">{entryType}</Badge>
            </div>
            <Input
              value={entryName}
              onChange={(e) => setEntryName(e.target.value)}
              disabled={isReadonly}
              className="border-none bg-transparent px-0 text-[length:--text-2xl] font-[--font-display] font-bold text-text-primary focus-visible:ring-0 focus-visible:outline-none h-auto disabled:opacity-100 disabled:cursor-default"
            />
          </div>
        </div>
        <div className="flex gap-2 items-center">
          {error && <span className="text-[length:--text-sm] text-danger">{error}</span>}
          {saved && (
            <span className="flex items-center text-[length:--text-sm] text-success">
              <CheckCircle className="size-4 mr-1" /> Saved
            </span>
          )}
          {!isReadonly && (
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Save className="mr-2 size-4" />
              )}
              Save
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* ── Main content (left 2/3) ──────── */}
        <div className="xl:col-span-2 space-y-6">
          {/* Description */}
          <Card>
            <CardHeader>
              <CardTitle className="text-[length:--text-base]">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={entryDescription}
                onChange={(e) => setEntryDescription(e.target.value)}
                rows={5}
                disabled={isReadonly}
                className="resize-none leading-relaxed disabled:opacity-100 disabled:cursor-default"
                placeholder="Describe this entry..."
              />
            </CardContent>
          </Card>
        </div>

        {/* ── Sidebar (right 1/3) ─────────── */}
        <div className="space-y-6">
          {/* Entry Type */}
          <Card>
            <CardHeader>
              <CardTitle className="text-[length:--text-base]">Entry Type</CardTitle>
            </CardHeader>
            <CardContent>
              <Select value={entryType} onValueChange={setEntryType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENTRY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Attributes */}
          <Card>
            <CardHeader>
              <CardTitle className="text-[length:--text-base]">Attributes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {Object.entries(attributes).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 text-[length:--text-xs] font-medium text-text-muted uppercase tracking-wider">
                    {key}
                  </span>
                  <Input
                    value={value}
                    onChange={(e) => setAttributes((prev) => ({ ...prev, [key]: e.target.value }))}
                    className="h-8 text-[length:--text-sm]"
                  />
                  <button
                    onClick={() => removeAttribute(key)}
                    className="shrink-0 rounded-[--radius-sm] p-1 text-text-muted hover:text-danger transition-colors cursor-pointer"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              <Separator className="my-3" />
              <div className="flex items-center gap-2">
                <Input
                  value={newAttrKey}
                  onChange={(e) => setNewAttrKey(e.target.value)}
                  placeholder="Key"
                  className="h-8 w-28 shrink-0 text-[length:--text-sm]"
                />
                <Input
                  value={newAttrValue}
                  onChange={(e) => setNewAttrValue(e.target.value)}
                  placeholder="Value"
                  className="h-8 text-[length:--text-sm]"
                  onKeyDown={(e) => e.key === 'Enter' && addAttribute()}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={addAttribute}
                  className="shrink-0 size-8"
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Danger zone */}
          {!isReadonly && (
            <Accordion type="single" collapsible>
              <AccordionItem value="danger" className="border-danger/20">
                <AccordionTrigger className="text-danger/80 hover:text-danger">
                  Danger Zone
                </AccordionTrigger>
                <AccordionContent>
                  <Button
                    variant="danger"
                    className="w-full"
                    onClick={handleDelete}
                    disabled={deleting}
                  >
                    {deleting ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 size-4" />
                    )}
                    Delete Entry
                  </Button>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </div>
      </div>
    </div>
  );
}
