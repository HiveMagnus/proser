'use client';

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  Users,
  MapPin,
  Crown,
  Sword,
  ScrollText,
  Save,
  Trash2,
  Loader2,
  X,
  CheckCircle,
  Plus,
  GripVertical,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { updateCodexEntry, deleteCodexEntry, type CodexEntry } from '@/lib/api';

/* ─────────────────────── Types ─────────────────────── */

interface GraphNode {
  id: string;
  entry: CodexEntry;
  label: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

interface GraphEdge {
  source: string; // node id
  target: string; // node id
  label: string;
  entry: CodexEntry; // the relationship entry
}

/* ─────────────────── Node colours ──────────────────── */

const typeColors: Record<string, { bg: string; border: string; text: string }> = {
  character: { bg: 'rgba(139,92,246,0.15)', border: '#8b5cf6', text: '#c4b5fd' },
  faction: { bg: 'rgba(234,179,8,0.15)', border: '#eab308', text: '#fde68a' },
  location: { bg: 'rgba(34,197,94,0.15)', border: '#22c55e', text: '#86efac' },
  item: { bg: 'rgba(59,130,246,0.15)', border: '#3b82f6', text: '#93c5fd' },
  default: { bg: 'rgba(148,163,184,0.15)', border: '#94a3b8', text: '#cbd5e1' },
};

const typeIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  character: Users,
  faction: Crown,
  location: MapPin,
  item: Sword,
};

const ENTITY_TYPES = [
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

/* ────────────── Parse relationship names ───────────── */

function parseRelationshipName(name: string): { from: string; to: string; label: string } | null {
  // "A ↔ B — Label" or "A → B — Label"
  const biMatch = name.match(/^(.+?)\s*↔\s*(.+?)(?:\s*[—–-]\s*(.+))?$/);
  if (biMatch) {
    return { from: biMatch[1]!.trim(), to: biMatch[2]!.trim(), label: biMatch[3]?.trim() ?? '' };
  }
  const uniMatch = name.match(/^(.+?)\s*→\s*(.+?)(?:\s*[—–-]\s*(.+))?$/);
  if (uniMatch) {
    return { from: uniMatch[1]!.trim(), to: uniMatch[2]!.trim(), label: uniMatch[3]?.trim() ?? '' };
  }
  return null;
}

function findNodeByLabel(nodes: GraphNode[], label: string): GraphNode | undefined {
  const lower = label.toLowerCase();
  return nodes.find(
    (n) => n.label.toLowerCase() === lower || n.label.toLowerCase().includes(lower),
  );
}

/* ────────────── Build graph from entries ───────────── */

function buildGraph(
  entries: CodexEntry[],
  width: number,
  height: number,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const entityTypes = new Set(['character', 'faction', 'location', 'item']);

  // Create entity nodes
  const nodes: GraphNode[] = entries
    .filter((e) => entityTypes.has(e.entryType))
    .map((e, i, arr) => {
      const angle = (2 * Math.PI * i) / Math.max(arr.length, 1);
      const radius = Math.min(width, height) * 0.3;
      return {
        id: e.id,
        entry: e,
        label: e.entryName,
        type: e.entryType,
        x: width / 2 + radius * Math.cos(angle),
        y: height / 2 + radius * Math.sin(angle),
        vx: 0,
        vy: 0,
        pinned: false,
      };
    });

  // Create edges from relationship entries
  const edges: GraphEdge[] = [];
  const relEntries = entries.filter((e) => e.entryType === 'relationship');
  for (const rel of relEntries) {
    const parsed = parseRelationshipName(rel.entryName);
    if (!parsed) continue;
    const source = findNodeByLabel(nodes, parsed.from);
    const target = findNodeByLabel(nodes, parsed.to);
    if (source && target) {
      edges.push({ source: source.id, target: target.id, label: parsed.label, entry: rel });
    }
  }

  return { nodes, edges };
}

/* ──────────── Simple force simulation step ─────────── */

function simulationStep(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
  alpha: number,
): GraphNode[] {
  const updated = nodes.map((n) => ({ ...n }));
  const repulsion = 8000;
  const attraction = 0.005;
  const centerPull = 0.01;
  const damping = 0.6;

  // Repulsion between all nodes
  for (let i = 0; i < updated.length; i++) {
    for (let j = i + 1; j < updated.length; j++) {
      const a = updated[i]!;
      const b = updated[j]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (repulsion * alpha) / (dist * dist);
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      if (!a.pinned) {
        a.vx += dx;
        a.vy += dy;
      }
      if (!b.pinned) {
        b.vx -= dx;
        b.vy -= dy;
      }
    }
  }

  // Attraction along edges
  for (const edge of edges) {
    const source = updated.find((n) => n.id === edge.source);
    const target = updated.find((n) => n.id === edge.target);
    if (!source || !target) continue;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const force = attraction * alpha;
    if (!source.pinned) {
      source.vx += dx * force;
      source.vy += dy * force;
    }
    if (!target.pinned) {
      target.vx -= dx * force;
      target.vy -= dy * force;
    }
  }

  // Center gravity
  for (const node of updated) {
    if (node.pinned) continue;
    node.vx += (width / 2 - node.x) * centerPull * alpha;
    node.vy += (height / 2 - node.y) * centerPull * alpha;
  }

  // Apply velocity
  for (const node of updated) {
    if (node.pinned) continue;
    node.vx *= damping;
    node.vy *= damping;
    node.x += node.vx;
    node.y += node.vy;
    // Clamp to bounds
    const pad = 50;
    node.x = Math.max(pad, Math.min(width - pad, node.x));
    node.y = Math.max(pad, Math.min(height - pad, node.y));
  }

  return updated;
}

/* ──────────────── CRUD Modal Component ─────────────── */

function EntryModal({
  entry,
  bookId,
  isDemo,
  onClose,
  onSaved,
  onDeleted,
}: {
  entry: CodexEntry;
  bookId: string;
  isDemo: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(entry.entryName);
  const [type, setType] = useState(entry.entryType);
  const [desc, setDesc] = useState(entry.entryDescription ?? '');
  const [attrs, setAttrs] = useState<Record<string, string>>(() => {
    try {
      return entry.attributes ? JSON.parse(entry.attributes) : {};
    } catch {
      return {};
    }
  });
  const [newAttrKey, setNewAttrKey] = useState('');
  const [newAttrValue, setNewAttrValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (isDemo) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updateCodexEntry(bookId, entry.id, {
        entryName: name,
        entryType: type,
        entryDescription: desc || undefined,
        attributes: Object.keys(attrs).length > 0 ? JSON.stringify(attrs) : undefined,
      });
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        onSaved();
      }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (isDemo || !confirm('Delete this entry? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await deleteCodexEntry(bookId, entry.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setDeleting(false);
    }
  };

  const addAttribute = () => {
    if (!newAttrKey.trim()) return;
    setAttrs((prev) => ({ ...prev, [newAttrKey]: newAttrValue }));
    setNewAttrKey('');
    setNewAttrValue('');
  };

  const removeAttribute = (key: string) => {
    setAttrs((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const Icon = typeIcons[type] ?? ScrollText;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-[--radius-md] bg-accent-500/10">
              <Icon className="size-4 text-accent-400" />
            </div>
            <DialogTitle className="text-[length:--text-lg]">
              {isDemo ? 'View Entry' : 'Edit Entry'}
            </DialogTitle>
          </div>
          {isDemo && (
            <DialogDescription className="text-warning">
              Demo data — create a book to edit entries.
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div>
            <label className="text-[length:--text-sm] font-medium text-text-primary">Name</label>
            <Input
              className="mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isDemo}
            />
          </div>
          <div>
            <label className="text-[length:--text-sm] font-medium text-text-primary">Type</label>
            <Select value={type} onValueChange={setType} disabled={isDemo}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[length:--text-sm] font-medium text-text-primary">
              Description
            </label>
            <Textarea
              className="mt-1"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={3}
              disabled={isDemo}
            />
          </div>

          {/* Attributes */}
          <div>
            <label className="text-[length:--text-sm] font-medium text-text-primary">
              Attributes
            </label>
            <div className="mt-1 space-y-1.5">
              {Object.entries(attrs).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-[length:--text-xs] font-medium text-text-muted uppercase tracking-wider">
                    {key}
                  </span>
                  <Input
                    value={value}
                    onChange={(e) => setAttrs((prev) => ({ ...prev, [key]: e.target.value }))}
                    className="h-8 text-[length:--text-sm]"
                    disabled={isDemo}
                  />
                  {!isDemo && (
                    <button
                      onClick={() => removeAttribute(key)}
                      className="shrink-0 rounded-[--radius-sm] p-1 text-text-muted hover:text-danger transition-colors cursor-pointer"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {!isDemo && (
                <div className="flex items-center gap-2">
                  <Input
                    value={newAttrKey}
                    onChange={(e) => setNewAttrKey(e.target.value)}
                    placeholder="Key"
                    className="h-8 w-24 shrink-0 text-[length:--text-sm]"
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
              )}
            </div>
          </div>

          {/* Actions */}
          {error && <p className="text-[length:--text-sm] text-danger">{error}</p>}
          {!isDemo && (
            <div className="flex items-center justify-between pt-2 border-t border-border-muted">
              <Button variant="danger" size="sm" onClick={handleDelete} disabled={deleting}>
                {deleting ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1.5 size-3.5" />
                )}
                Delete
              </Button>
              <div className="flex items-center gap-2">
                {saved && (
                  <span className="flex items-center text-[length:--text-sm] text-success">
                    <CheckCircle className="size-3.5 mr-1" /> Saved
                  </span>
                )}
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <Save className="mr-1.5 size-3.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────── Edge label click modal ───────────────── */

function EdgeModal({
  edge,
  bookId,
  isDemo,
  onClose,
  onSaved,
  onDeleted,
}: {
  edge: GraphEdge;
  bookId: string;
  isDemo: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  return (
    <EntryModal
      entry={edge.entry}
      bookId={bookId}
      isDemo={isDemo}
      onClose={onClose}
      onSaved={onSaved}
      onDeleted={onDeleted}
    />
  );
}

/* ──────────── Main Graph Component ─────────────────── */

const NODE_RADIUS = 36;
const GRAPH_HEIGHT = 560;

export function RelationshipGraph({
  entries,
  bookId,
  isDemo,
  onDataChanged,
}: {
  entries: CodexEntry[];
  bookId: string;
  isDemo: boolean;
  onDataChanged: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const [width, setWidth] = useState(800);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const alphaRef = useRef(1);
  const nodesRef = useRef<GraphNode[]>([]);

  // Measure container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  // Build graph when entries or dimensions change
  useEffect(() => {
    const { nodes: n, edges: e } = buildGraph(entries, width, GRAPH_HEIGHT);
    setNodes(n);
    setEdges(e);
    nodesRef.current = n;
    alphaRef.current = 1; // restart simulation
  }, [entries, width]);

  // Run force simulation
  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      if (alphaRef.current > 0.001) {
        const next = simulationStep(nodesRef.current, edges, width, GRAPH_HEIGHT, alphaRef.current);
        nodesRef.current = next;
        setNodes(next);
        alphaRef.current *= 0.97;
      }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [edges, width]);

  // Drag handlers
  const handleMouseDown = useCallback((nodeId: string, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(nodeId);
    nodesRef.current = nodesRef.current.map((n) => (n.id === nodeId ? { ...n, pinned: true } : n));
    alphaRef.current = Math.max(alphaRef.current, 0.3);
  }, []);

  const handleMouseMove = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (!dragging) return;
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      nodesRef.current = nodesRef.current.map((n) =>
        n.id === dragging ? { ...n, x: mx, y: my, vx: 0, vy: 0 } : n,
      );
      setNodes([...nodesRef.current]);
      alphaRef.current = Math.max(alphaRef.current, 0.1);
    },
    [dragging],
  );

  const handleMouseUp = useCallback(() => {
    if (dragging) {
      nodesRef.current = nodesRef.current.map((n) =>
        n.id === dragging ? { ...n, pinned: false } : n,
      );
      setDragging(null);
    }
  }, [dragging]);

  const handleNodeClick = useCallback(
    (node: GraphNode, e: ReactMouseEvent) => {
      e.stopPropagation();
      if (!dragging) {
        setSelectedNode(node);
        setSelectedEdge(null);
      }
    },
    [dragging],
  );

  const handleEdgeLabelClick = useCallback((edge: GraphEdge, e: ReactMouseEvent) => {
    e.stopPropagation();
    setSelectedEdge(edge);
    setSelectedNode(null);
  }, []);

  // Arrow from edge midpoint
  const edgeElements = edges.map((edge) => {
    const source = nodes.find((n) => n.id === edge.source);
    const target = nodes.find((n) => n.id === edge.target);
    if (!source || !target) return null;

    const mx = (source.x + target.x) / 2;
    const my = (source.y + target.y) / 2;
    const isHighlighted = hovered === edge.source || hovered === edge.target;

    return (
      <g key={`${edge.source}-${edge.target}-${edge.entry.id}`}>
        <line
          x1={source.x}
          y1={source.y}
          x2={target.x}
          y2={target.y}
          stroke={isHighlighted ? 'var(--color-accent-400)' : 'var(--color-border-strong)'}
          strokeWidth={isHighlighted ? 2.5 : 1.5}
          strokeDasharray={isHighlighted ? undefined : '6 3'}
          opacity={isHighlighted ? 1 : 0.6}
          className="transition-all duration-200"
        />
        {edge.label && (
          <g className="cursor-pointer" onClick={(e) => handleEdgeLabelClick(edge, e)}>
            <rect
              x={mx - 4}
              y={my - 10}
              width={edge.label.length * 6.5 + 8}
              height={18}
              rx={4}
              fill="var(--color-surface-raised)"
              stroke={isHighlighted ? 'var(--color-accent-500)' : 'var(--color-border-muted)'}
              strokeWidth={1}
              className="transition-all duration-200"
            />
            <text
              x={mx}
              y={my + 3}
              fill={isHighlighted ? 'var(--color-accent-300)' : 'var(--color-text-muted)'}
              fontSize="11"
              fontWeight="500"
              className="transition-all duration-200 select-none"
            >
              {edge.label}
            </text>
          </g>
        )}
      </g>
    );
  });

  const nodeElements = nodes.map((node) => {
    const colors = typeColors[node.type] ?? typeColors.default!;
    const Icon = typeIcons[node.type] ?? ScrollText;
    const isHov = hovered === node.id;
    const r = NODE_RADIUS;

    return (
      <g
        key={node.id}
        transform={`translate(${node.x}, ${node.y})`}
        className="cursor-pointer"
        onMouseDown={(e) => handleMouseDown(node.id, e)}
        onMouseEnter={() => setHovered(node.id)}
        onMouseLeave={() => setHovered(null)}
        onClick={(e) => handleNodeClick(node, e)}
      >
        {/* Outer glow on hover */}
        {isHov && (
          <circle r={r + 6} fill="none" stroke={colors.border} strokeWidth={2} opacity={0.3} />
        )}
        {/* Node circle */}
        <circle
          r={r}
          fill={colors.bg}
          stroke={colors.border}
          strokeWidth={isHov ? 2.5 : 1.5}
          className="transition-all duration-200"
        />
        {/* Icon */}
        <foreignObject x={-10} y={-16} width={20} height={20} className="pointer-events-none">
          <Icon className="size-4" style={{ color: colors.text }} />
        </foreignObject>
        {/* Label */}
        <text
          y={12}
          textAnchor="middle"
          fill={colors.text}
          fontSize="10"
          fontWeight="600"
          className="select-none pointer-events-none"
        >
          {node.label.length > 14 ? node.label.slice(0, 12) + '…' : node.label}
        </text>
      </g>
    );
  });

  const isEmpty = nodes.length === 0;

  return (
    <div ref={containerRef} className="relative">
      <div className="rounded-[--radius-lg] border border-border-muted bg-surface-sunken overflow-hidden">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <Users className="size-8 mb-3 opacity-50" />
            <p className="text-[length:--text-sm] font-medium">No entities to graph</p>
            <p className="text-[length:--text-xs] mt-1">
              Add characters, factions, or locations and connect them with relationships.
            </p>
          </div>
        ) : (
          <svg
            width={width}
            height={GRAPH_HEIGHT}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            className="select-none"
          >
            {/* Subtle grid pattern */}
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path
                  d="M 40 0 L 0 0 0 40"
                  fill="none"
                  stroke="var(--color-border-muted)"
                  strokeWidth="0.5"
                  opacity="0.3"
                />
              </pattern>
            </defs>
            <rect width={width} height={GRAPH_HEIGHT} fill="url(#grid)" />

            {edgeElements}
            {nodeElements}
          </svg>
        )}
      </div>

      {/* Legend */}
      {!isEmpty && (
        <div className="flex flex-wrap items-center gap-4 mt-3 px-1">
          <span className="text-[length:--text-xs] text-text-muted">
            <GripVertical className="inline size-3 mr-0.5" />
            Drag to rearrange
          </span>
          {Object.entries(typeColors)
            .filter(([k]) => k !== 'default' && nodes.some((n) => n.type === k))
            .map(([type, c]) => (
              <span key={type} className="flex items-center gap-1 text-[length:--text-xs]">
                <span
                  className="inline-block size-3 rounded-[--radius-full] border"
                  style={{ background: c.bg, borderColor: c.border }}
                />
                <span className="text-text-muted capitalize">{type}</span>
              </span>
            ))}
          <span className="text-[length:--text-xs] text-text-muted ml-auto">
            Click nodes or edge labels to edit
          </span>
        </div>
      )}

      {/* CRUD Modal */}
      {selectedNode && (
        <EntryModal
          entry={selectedNode.entry}
          bookId={bookId}
          isDemo={isDemo}
          onClose={() => setSelectedNode(null)}
          onSaved={() => {
            setSelectedNode(null);
            onDataChanged();
          }}
          onDeleted={() => {
            setSelectedNode(null);
            onDataChanged();
          }}
        />
      )}
      {selectedEdge && (
        <EdgeModal
          edge={selectedEdge}
          bookId={bookId}
          isDemo={isDemo}
          onClose={() => setSelectedEdge(null)}
          onSaved={() => {
            setSelectedEdge(null);
            onDataChanged();
          }}
          onDeleted={() => {
            setSelectedEdge(null);
            onDataChanged();
          }}
        />
      )}
    </div>
  );
}
