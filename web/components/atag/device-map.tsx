"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import { Crosshair, Map as MapIcon, Minus, Plus, RefreshCw, Route, ScanSearch, WifiOff } from "lucide-react";
import type { LocationReport, TagDevice } from "@/lib/contracts";
import { formatAccuracy, formatCoordinates, isStale, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface MapInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface DeviceMapProps {
  devices: TagDevice[];
  selectedId: string | null;
  /** Reports for the selected device in the chosen range, newest first. */
  track: LocationReport[];
  focusedReportId: string | null;
  onSelectDevice(id: string): void;
  onFocusReport(id: string): void;
  insets: MapInsets;
}

type TileState = "loading" | "ok" | "error";

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> 贡献者';
/** Neutral overview used when nothing has a location yet. */
/** Neutral world view until a device with a report is shown; never a sample location. */
const FALLBACK_VIEW: [number, number] = [20, 0];

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function DeviceMap({ devices, selectedId, track, focusedReportId, onSelectDevice, onFocusReport, insets }: DeviceMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const tileRef = useRef<Leaflet.TileLayer | null>(null);
  const deviceLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const trackLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const focusLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const insetsRef = useRef(insets);
  const handlersRef = useRef({ onSelectDevice, onFocusReport });
  useEffect(() => {
    insetsRef.current = insets;
    handlersRef.current = { onSelectDevice, onFocusReport };
  });

  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState(false);
  const [tileState, setTileState] = useState<TileState>("loading");
  const [zoom, setZoom] = useState(2);

  const selected = useMemo(() => devices.find((d) => d.id === selectedId) ?? null, [devices, selectedId]);
  const focused = useMemo(() => {
    if (!selected) return null;
    return track.find((r) => r.id === focusedReportId) ?? selected.latestReport;
  }, [selected, track, focusedReportId]);
  const located = useMemo(() => devices.filter((d) => d.latestReport), [devices]);

  // ---- Mount Leaflet on the client only ----
  useEffect(() => {
    let disposed = false;
    let tileErrors = 0;
    void import("leaflet")
      .then((module) => {
        if (disposed || !containerRef.current) return;
        const L = (module as unknown as { default?: typeof Leaflet }).default ?? (module as unknown as typeof Leaflet);
        leafletRef.current = L;
        const map = L.map(containerRef.current, {
          zoomControl: false,
          attributionControl: true,
          worldCopyJump: true,
          center: FALLBACK_VIEW,
          zoom: 2,
          zoomSnap: 0.5,
        });
        map.attributionControl.setPrefix(
          '<a href="https://leafletjs.com" target="_blank" rel="noreferrer">Leaflet</a>',
        );
        const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION, crossOrigin: true });
        tiles.on("tileload", () => {
          tileErrors = 0;
          setTileState("ok");
        });
        tiles.on("tileerror", () => {
          tileErrors += 1;
          if (tileErrors >= 4) setTileState((s) => (s === "ok" ? s : "error"));
        });
        tiles.addTo(map);
        tileRef.current = tiles;
        deviceLayerRef.current = L.layerGroup().addTo(map);
        trackLayerRef.current = L.layerGroup().addTo(map);
        focusLayerRef.current = L.layerGroup().addTo(map);
        map.on("zoomend", () => setZoom(map.getZoom()));
        mapRef.current = map;
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setInitError(true);
      });

    const goOffline = () => setTileState("error");
    window.addEventListener("offline", goOffline);
    return () => {
      disposed = true;
      window.removeEventListener("offline", goOffline);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Keep Leaflet's size in sync with layout changes (sheet expand, resize).
  useEffect(() => {
    const map = mapRef.current;
    const el = containerRef.current;
    if (!ready || !map || !el) return;
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ready]);

  const viewWithInsets = useCallback((lat: number, lng: number, targetZoom?: number) => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;
    const z = targetZoom ?? Math.max(map.getZoom(), 15);
    const pad = insetsRef.current;
    const point = map.project([lat, lng], z).add(L.point((pad.right - pad.left) / 2, (pad.bottom - pad.top) / 2));
    map.flyTo(map.unproject(point, z), z, { duration: 0.6 });
  }, []);

  const fitPoints = useCallback((points: [number, number][]) => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L || points.length === 0) return;
    const pad = insetsRef.current;
    if (points.length === 1) {
      viewWithInsets(points[0][0], points[0][1], 15);
      return;
    }
    map.flyToBounds(L.latLngBounds(points), {
      paddingTopLeft: [pad.left + 40, pad.top + 40],
      paddingBottomRight: [pad.right + 40, pad.bottom + 40],
      maxZoom: 16,
      duration: 0.6,
    });
  }, [viewWithInsets]);

  // ---- Device markers ----
  useEffect(() => {
    const L = leafletRef.current;
    const layer = deviceLayerRef.current;
    if (!ready || !L || !layer) return;
    layer.clearLayers();
    for (const device of located) {
      const report = device.latestReport!;
      const isSelected = device.id === selectedId;
      const stale = isStale(report);
      // Profile metadata may come from imported files and is untrusted; this value is interpolated into HTML.
      const markerColor = /^#[0-9a-f]{6}$/i.test(device.color) ? device.color : "#e8590c";
      const icon = L.divIcon({
        className: "",
        iconSize: [34, 34],
        iconAnchor: [17, 17],
        html: `<div class="atag-pin${isSelected ? " atag-pin--selected" : ""}${stale ? " atag-pin--stale" : ""}" style="--pin-color:${markerColor}"><span class="atag-pin__dot"></span>${
          isSelected ? `<span class="atag-pin__label">${escapeHtml(device.name)}</span>` : ""
        }</div>`,
      });
      L.marker([report.latitude, report.longitude], {
        icon,
        title: `${device.name} · ${relativeTime(report.observedAt)}`,
        alt: device.name,
        keyboard: true,
        zIndexOffset: isSelected ? 1000 : 0,
        riseOnHover: true,
      })
        .on("click", () => handlersRef.current.onSelectDevice(device.id))
        .addTo(layer);
    }
  }, [ready, located, selectedId]);

  // ---- History track ----
  useEffect(() => {
    const L = leafletRef.current;
    const layer = trackLayerRef.current;
    if (!ready || !L || !layer) return;
    layer.clearLayers();
    if (!selected || track.length === 0) return;
    const chronological = [...track].reverse();
    if (chronological.length > 1) {
      L.polyline(
        chronological.map((r) => [r.latitude, r.longitude] as [number, number]),
        { color: selected.color, weight: 3, opacity: 0.55, dashArray: "2 7", lineCap: "round" },
      ).addTo(layer);
    }
    for (const report of chronological) {
      if (report.id === selected.latestReport?.id) continue;
      L.circleMarker([report.latitude, report.longitude], {
        radius: 4.5,
        color: "#fffdf9",
        weight: 2,
        fillColor: selected.color,
        fillOpacity: 0.85,
        className: "atag-trackpoint",
      })
        .bindTooltip(relativeTime(report.observedAt), { direction: "top", offset: [0, -4] })
        .on("click", () => handlersRef.current.onFocusReport(report.id))
        .addTo(layer);
    }
  }, [ready, selected, track]);

  // ---- Focus: accuracy circle + highlighted report ----
  useEffect(() => {
    const L = leafletRef.current;
    const layer = focusLayerRef.current;
    if (!ready || !L || !layer) return;
    layer.clearLayers();
    if (!selected || !focused) return;
    L.circle([focused.latitude, focused.longitude], {
      radius: focused.horizontalAccuracyMeters,
      color: selected.color,
      weight: 1.5,
      opacity: 0.6,
      fillColor: selected.color,
      fillOpacity: 0.1,
      interactive: false,
    }).addTo(layer);
    if (focused.id !== selected.latestReport?.id) {
      L.circleMarker([focused.latitude, focused.longitude], {
        radius: 9,
        color: selected.color,
        weight: 3,
        fillColor: "#fffdf9",
        fillOpacity: 1,
        interactive: false,
      }).addTo(layer);
    }
  }, [ready, selected, focused]);

  // Keep the OSM attribution visible beside the detail panel / above the mobile sheet.
  useEffect(() => {
    const corner = containerRef.current?.querySelector<HTMLElement>(".leaflet-bottom.leaflet-right");
    if (!ready || !corner) return;
    corner.style.marginBottom = `${insets.bottom}px`;
    corner.style.marginRight = `${insets.right}px`;
  }, [ready, insets.bottom, insets.right]);

  // Pan when the selected device or focused report actually changes (not on every refetch).
  const focusId = focused?.id;
  const focusLat = focused?.latitude;
  const focusLng = focused?.longitude;
  useEffect(() => {
    if (!ready || focusLat === undefined || focusLng === undefined) return;
    viewWithInsets(focusLat, focusLng);
  }, [ready, selectedId, focusId, focusLat, focusLng, viewWithInsets]);

  // First load: frame all located devices if nothing is selected.
  const framedRef = useRef(false);
  useEffect(() => {
    if (!ready || framedRef.current || located.length === 0 || selectedId) return;
    framedRef.current = true;
    fitPoints(located.map((d) => [d.latestReport!.latitude, d.latestReport!.longitude]));
  }, [ready, located, selectedId, fitPoints]);

  const retryTiles = () => {
    setTileState("loading");
    tileRef.current?.redraw();
  };

  const controlButton =
    "grid size-10 place-items-center rounded-xl text-ink transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 lg:size-9";

  return (
    <div className="relative isolate h-full w-full overflow-hidden bg-paper-deep">
      <div ref={containerRef} className="atag-map absolute inset-0 z-0" role="region" aria-label="设备位置地图" />

      {!ready && !initError && (
        <div className="absolute inset-0 grid place-items-center text-sm text-ink-soft">
          <span className="inline-flex items-center gap-2">
            <MapIcon className="size-4 animate-pulse" /> 正在加载地图…
          </span>
        </div>
      )}

      {(initError || tileState === "error") && (
        <div
          role="status"
          className="absolute left-1/2 z-[500] w-[min(420px,calc(100%-24px))] -translate-x-1/2 rounded-2xl border border-line bg-card/95 p-3.5 text-sm shadow-lg backdrop-blur"
          style={{ top: insets.top + 12 }}
        >
          <div className="flex items-start gap-3">
            <WifiOff className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{initError ? "地图组件加载失败" : "地图瓦片无法加载"}</p>
              <p className="mt-0.5 text-ink-soft">
                可能处于离线状态或 OpenStreetMap 无法访问。位置报告仍可查看：
              </p>
              {focused ? (
                <p className="mt-1.5 font-mono text-[13px] text-ink">
                  {formatCoordinates(focused.latitude, focused.longitude)}
                  <span className="ml-2 font-sans text-ink-soft">{formatAccuracy(focused.horizontalAccuracyMeters)}</span>
                </p>
              ) : (
                <p className="mt-1.5 text-ink-soft">在列表中选择设备查看坐标。</p>
              )}
            </div>
            {!initError && (
              <button type="button" onClick={retryTiles} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-persimmon-ink hover:bg-persimmon-wash">
                <RefreshCw className="size-3.5" /> 重试
              </button>
            )}
          </div>
        </div>
      )}

      {ready && (
        <div
          className="absolute z-[500] flex flex-col gap-1 rounded-2xl border border-line bg-card/95 p-1 shadow-md backdrop-blur"
          style={{ right: insets.right + 12, bottom: insets.bottom + 28 }}
        >
          <button type="button" className={controlButton} onClick={() => mapRef.current?.zoomIn()} disabled={zoom >= 19} aria-label="放大" title="放大">
            <Plus className="size-[18px]" />
          </button>
          <button type="button" className={controlButton} onClick={() => mapRef.current?.zoomOut()} disabled={zoom <= 2} aria-label="缩小" title="缩小">
            <Minus className="size-[18px]" />
          </button>
          <span aria-hidden="true" className="mx-2 h-px bg-line" />
          <button
            type="button"
            className={controlButton}
            onClick={() => focused && viewWithInsets(focused.latitude, focused.longitude, 16)}
            disabled={!focused}
            aria-label="回到选中设备"
            title={focused ? "回到选中设备" : "选中设备暂无位置"}
          >
            <Crosshair className="size-[18px]" />
          </button>
          <button
            type="button"
            className={controlButton}
            onClick={() => fitPoints(track.map((r) => [r.latitude, r.longitude]))}
            disabled={track.length < 2}
            aria-label="显示完整轨迹"
            title={track.length < 2 ? "所选时间段内报告不足以形成轨迹" : "显示完整轨迹"}
          >
            <Route className="size-[18px]" />
          </button>
          <button
            type="button"
            className={controlButton}
            onClick={() => fitPoints(located.map((d) => [d.latestReport!.latitude, d.latestReport!.longitude]))}
            disabled={located.length === 0}
            aria-label="显示全部设备"
            title="显示全部设备"
          >
            <ScanSearch className="size-[18px]" />
          </button>
        </div>
      )}

      {ready && selected && !selected.latestReport && (
        <div
          className="pointer-events-none absolute left-1/2 z-[400] -translate-x-1/2 rounded-full border border-line bg-card/95 px-4 py-2 text-sm text-ink-soft shadow-md"
          style={{ top: insets.top + 12 + (tileState === "error" ? 120 : 0) }}
        >
          <span className={cn("font-medium text-ink")}>{selected.name}</span> 暂无位置报告
        </div>
      )}
    </div>
  );
}
