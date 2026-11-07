"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import {
  ReactFlow,
  Handle,
  Position,
  Controls,
  BaseEdge,
  getBezierPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

// Force-stop FE animation if a provider stays active longer than this
const FE_ACTIVE_TIMEOUT_MS = 60000;
const FE_ACTIVE_TICK_MS = 1000;

// Kame + electric particles along active edges
const KAME_PARTICLE_COUNT = 6;
const SPARK_COUNT = 5;

function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function getProviderImageUrl(providerId) {
  return getProviderIconSrc(providerId);
}

// Custom account/provider node - rectangle with image + account email/name + provider subtitle + usage badge
function ProviderNode({ data }) {
  const { label, subLabel, color, imageUrl, textIcon, active, usage } = data;
  const [imgError, setImgError] = useState(false);

  const tokensText = usage?.totalTokens ? `${fmtTokens(usage.totalTokens)} tok` : null;
  const reqsText = usage?.requests ? `${usage.requests} reqs` : null;
  const usageBadge = tokensText && reqsText ? `${reqsText} · ${tokensText}` : (tokensText || reqsText || "0 reqs");

  return (
    <div
      className="flex flex-col gap-1 px-3.5 py-2.5 rounded-xl border-2 transition-all duration-300 bg-bg shadow-sm"
      style={{
        borderColor: active ? color : "var(--color-border)",
        boxShadow: active ? `0 0 18px ${color}50` : "0 2px 6px rgba(0,0,0,0.03)",
        minWidth: "175px",
        maxWidth: "230px",
      }}
    >
      <Handle type="target" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      <div className="flex items-center gap-2.5">
        {/* Provider icon */}
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border border-black/5 dark:border-white/5"
          style={{ backgroundColor: `${color}15` }}
        >
          {imageUrl && !imgError ? (
            <img
              src={imageUrl}
              alt={label}
              className="w-5 h-5 rounded-sm object-contain"
              loading="lazy"
              decoding="async"
              onError={() => {
                const m = imageUrl?.match(/^\/providers\/([^/]+)\.png$/i);
                if (m) markProviderIconMissing(m[1]);
                setImgError(true);
              }}
            />
          ) : (
            <span className="text-xs font-bold" style={{ color }}>{textIcon}</span>
          )}
        </div>

        {/* Account Name / Email + Provider Subtitle */}
        <div className="flex flex-col min-w-0 flex-1">
          <span
            className="text-sm font-semibold truncate leading-snug"
            style={{ color: active ? color : "var(--color-text)" }}
            title={label}
          >
            {label}
          </span>
          {subLabel && (
            <span className="text-[11px] text-text-muted truncate leading-tight">
              {subLabel}
            </span>
          )}
        </div>

        {/* Active indicator */}
        {active && (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: color }} />
            <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
          </span>
        )}
      </div>

      {/* Usage statistics badge */}
      <div className="mt-1 pt-1.5 border-t border-border/40 flex items-center justify-between text-[11px] text-text-muted font-mono">
        <span className="truncate">{usageBadge}</span>
        {usage?.cost > 0 && (
          <span className="text-warning font-semibold ml-1 shrink-0">${usage.cost.toFixed(2)}</span>
        )}
      </div>
    </div>
  );
}

ProviderNode.propTypes = {
  data: PropTypes.object.isRequired,
};

// Center 9Router node — pulse/glow on card only (no expanding rings)
function RouterNode({ data }) {
  const powering = (data.activeCount || 0) > 0;
  return (
    <div
      className={`relative z-[1] flex items-center justify-center px-5 py-3 rounded-xl border-2 min-w-[130px] ${
        powering
          ? "topology-router-core border-yellow-300 bg-gradient-to-br from-primary/30 via-yellow-400/20 to-cyan-400/25"
          : "border-primary bg-primary/5 shadow-md"
      }`}
      style={{
        boxShadow: powering
          ? "0 0 28px rgba(234,179,8,0.55), 0 0 12px rgba(6,182,212,0.6)"
          : "0 0 12px rgba(99,102,241,0.2)",
      }}
    >
      <Handle type="source" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      <div className="flex items-center gap-2">
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-lg text-sm font-black transition-all ${
            powering
              ? "bg-gradient-to-br from-yellow-300 to-amber-500 text-black shadow-[0_0_12px_#fde047]"
              : "bg-primary text-white"
          }`}
        >
          9
        </span>
        <span className="text-base font-bold text-text">9Router</span>
      </div>
    </div>
  );
}

RouterNode.propTypes = {
  data: PropTypes.object.isRequired,
};

function TopologyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  data = {},
}) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const active = !!data.active;

  if (!active) {
    return <BaseEdge id={id} path={edgePath} style={style} />;
  }

  return (
    <g>
      <path
        d={edgePath}
        fill="none"
        style={{ stroke: "#06b6d4", strokeWidth: 10, opacity: 0.25, filter: "blur(4px)" }}
      />
      <path
        d={edgePath}
        fill="none"
        style={{ stroke: "#38bdf8", strokeWidth: 5, opacity: 0.6 }}
      />
      <path
        d={edgePath}
        fill="none"
        style={{ stroke: "#f8fafc", strokeWidth: 2.2, opacity: 1 }}
        className="topology-edge-kame"
      />
      {Array.from({ length: KAME_PARTICLE_COUNT }, (_, i) => (
        <circle
          key={`${id}-p-${i}`}
          r={i % 2 === 0 ? 4 : 2.5}
          fill={i % 3 === 0 ? "#fde047" : i % 3 === 1 ? "#67e8f9" : "#fff"}
          opacity={0.95}
          style={{ filter: "drop-shadow(0 0 4px #22d3ee)" }}
        >
          <animateMotion
            dur={`${0.4 + i * 0.08}s`}
            repeatCount="indefinite"
            path={edgePath}
            begin={`${i * 0.09}s`}
          />
        </circle>
      ))}
      {Array.from({ length: SPARK_COUNT }, (_, i) => (
        <circle
          key={`${id}-s-${i}`}
          r={1.8}
          fill="#e0f2fe"
          opacity={0}
        >
          <animate
            attributeName="opacity"
            values="0;1;0;0;1;0"
            dur={`${0.35 + (i % 3) * 0.1}s`}
            begin={`${i * 0.07}s`}
            repeatCount="indefinite"
          />
          <animateMotion
            dur={`${0.28 + i * 0.05}s`}
            repeatCount="indefinite"
            path={edgePath}
            begin={`${i * 0.11}s`}
          />
        </circle>
      ))}
    </g>
  );
}

TopologyEdge.propTypes = {
  id: PropTypes.string,
  sourceX: PropTypes.number,
  sourceY: PropTypes.number,
  targetX: PropTypes.number,
  targetY: PropTypes.number,
  sourcePosition: PropTypes.string,
  targetPosition: PropTypes.string,
  style: PropTypes.object,
  data: PropTypes.object,
};

const nodeTypes = { provider: ProviderNode, router: RouterNode };
const edgeTypes = { topology: TopologyEdge };

// Place N nodes evenly along an ellipse around the router center.
function buildLayout(providers, activeSet, lastSet, errorSet, accountUsage = {}) {
  const nodeW = 195;
  const nodeH = 76;
  const routerW = 120;
  const routerH = 44;
  const nodeGap = 24;

  const count = providers.length;

  const minRx = ((nodeW + nodeGap) * count) / (2 * Math.PI);
  const rx = Math.max(340, minRx);
  const ry = Math.max(220, rx * 0.58);
  if (count === 0) {
    return {
      nodes: [{ id: "router", type: "router", position: { x: 0, y: 0 }, data: { activeCount: 0 }, draggable: false }],
      edges: [],
    };
  }

  const nodes = [];
  const edges = [];

  nodes.push({
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    data: { activeCount: activeSet.size },
    draggable: false,
  });

  const edgeStyle = (active, last, error) => {
    if (error) return { stroke: "#ef4444", strokeWidth: 2.5, opacity: 0.9 };
    if (active) return { stroke: "#22d3ee", strokeWidth: 3.5, opacity: 1 };
    if (last) return { stroke: "#f59e0b", strokeWidth: 2, opacity: 0.7 };
    return { stroke: "var(--color-border)", strokeWidth: 1, opacity: 0.3 };
  };

  providers.forEach((p, i) => {
    const config = getProviderConfig(p.provider);
    const connId = p.id || p.provider;
    const active = activeSet.has(connId) || activeSet.has(p.provider?.toLowerCase());
    const last = !active && (lastSet.has(connId) || lastSet.has(p.provider?.toLowerCase()));
    const error = !active && (errorSet.has(connId) || errorSet.has(p.provider?.toLowerCase()));
    const nodeId = `conn-${connId}`;

    const usage = accountUsage?.[p.id] || accountUsage?.[p.provider] || null;
    const providerName = config.name || p.nodeName || p.provider;
    const accountLabel = p.email || p.name || p.connectionName || providerName;
    const subLabel = (p.email || p.name) ? providerName : null;

    const data = {
      label: accountLabel,
      subLabel,
      color: config.color || "#6b7280",
      imageUrl: getProviderImageUrl(p.provider),
      textIcon: config.textIcon || (p.provider || "?").slice(0, 2).toUpperCase(),
      active,
      usage,
    };

    // Distribute evenly starting from top (−π/2), clockwise
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    const cx = rx * Math.cos(angle);
    const cy = ry * Math.sin(angle);

    let sourceHandle, targetHandle;
    if (Math.abs(angle + Math.PI / 2) < Math.PI / 4 || Math.abs(angle - 3 * Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "top"; targetHandle = "bottom";
    } else if (Math.abs(angle - Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "bottom"; targetHandle = "top";
    } else if (cx > 0) {
      sourceHandle = "right"; targetHandle = "left";
    } else {
      sourceHandle = "left"; targetHandle = "right";
    }

    nodes.push({
      id: nodeId,
      type: "provider",
      position: { x: cx - nodeW / 2, y: cy - nodeH / 2 },
      data,
      draggable: false,
    });

    edges.push({
      id: `e-${nodeId}`,
      type: "topology",
      source: "router",
      sourceHandle,
      target: nodeId,
      targetHandle,
      animated: false,
      data: { active },
      style: edgeStyle(active, last, error),
    });
  });

  return { nodes, edges };
}

export default function ProviderTopology({
  providers = [],
  accountUsage = {},
  activeRequests = [],
  lastProvider = "",
  errorProvider = "",
}) {
  const activeConnKey = useMemo(
    () => activeRequests.map((r) => r.connectionId || r.provider?.toLowerCase()).filter(Boolean).sort().join(","),
    [activeRequests]
  );
  const lastKey = lastProvider?.toLowerCase() || "";
  const errorKey = errorProvider?.toLowerCase() || "";

  const rawActiveSet = useMemo(() => new Set(activeConnKey ? activeConnKey.split(",") : []), [activeConnKey]);
  const lastSet = useMemo(() => new Set(lastKey ? [lastKey] : []), [lastKey]);
  const errorSet = useMemo(() => new Set(errorKey ? [errorKey] : []), [errorKey]);

  const firstSeenRef = useRef({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const seen = firstSeenRef.current;
    const now = Date.now();
    for (const p of rawActiveSet) {
      if (!seen[p]) seen[p] = now;
    }
    for (const p of Object.keys(seen)) {
      if (!rawActiveSet.has(p)) delete seen[p];
    }
  }, [rawActiveSet]);

  useEffect(() => {
    if (rawActiveSet.size === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), FE_ACTIVE_TICK_MS);
    return () => clearInterval(id);
  }, [rawActiveSet]);

  const activeSet = useMemo(() => {
    const now = Date.now();
    const filtered = new Set();
    for (const p of rawActiveSet) {
      const ts = firstSeenRef.current[p];
      if (!ts || now - ts < FE_ACTIVE_TIMEOUT_MS) filtered.add(p);
    }
    return filtered;
  }, [rawActiveSet, tick]);

  const { nodes, edges } = useMemo(
    () => buildLayout(providers, activeSet, lastSet, errorSet, accountUsage),
    [providers, activeSet, lastSet, errorSet, accountUsage]
  );

  const providersKey = useMemo(
    () => providers.map((p) => p.id || p.provider).join(","),
    [providers]
  );

  const containerRef = useRef(null);
  const rfInstance = useRef(null);
  const fitOpts = useMemo(() => ({ padding: 0.15, duration: 400 }), []);

  const onInit = useCallback((instance) => {
    rfInstance.current = instance;
    setTimeout(() => instance.fitView(fitOpts), 50);
  }, [fitOpts]);

  useEffect(() => {
    if (!containerRef.current) return;
    let resizeTimer = null;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (rfInstance.current) rfInstance.current.fitView(fitOpts);
      }, 100);
    });
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      clearTimeout(resizeTimer);
    };
  }, [fitOpts]);

  useEffect(() => {
    if (rfInstance.current) {
      const id = setTimeout(() => rfInstance.current.fitView(fitOpts), 50);
      return () => clearTimeout(id);
    }
  }, [nodes.length, fitOpts]);

  return (
    <div ref={containerRef} className="h-[340px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px]">
      {providers.length === 0 ? (
        <div className="h-full flex items-center justify-center text-text-muted text-sm">
          No accounts connected
        </div>
      ) : (
        <ReactFlow
          key={providersKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={fitOpts}
          minZoom={0.1}
          maxZoom={2}
          onInit={onInit}
          proOptions={{ hideAttribution: true }}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Controls showInteractive={false} className="react-flow-controls-custom" />
        </ReactFlow>
      )}
    </div>
  );
}

ProviderTopology.propTypes = {
  providers: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    provider: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
  })),
  accountUsage: PropTypes.object,
  activeRequests: PropTypes.arrayOf(PropTypes.shape({
    connectionId: PropTypes.string,
    provider: PropTypes.string,
    model: PropTypes.string,
    account: PropTypes.string,
  })),
  lastProvider: PropTypes.string,
  errorProvider: PropTypes.string,
};
