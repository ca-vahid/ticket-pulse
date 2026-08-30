import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { divIcon } from 'leaflet';
import { visualsAPI } from '../services/api';
import { ArrowLeft, Users, Crown, Activity, Loader, ChevronLeft, ChevronRight, Edit2, Check, X, Maximize, MapPinOff, AlertTriangle } from 'lucide-react';
import {
  MAP_DEFAULT_VIEW, PRESET_LOCATIONS, UNRESOLVED_LOCATION_HINT, resolveLocation,
} from '../utils/officeLocations';
import MobileTabBar from '../components/nav/MobileTabBar';
import SideRail from '../components/nav/SideRail';
import 'leaflet/dist/leaflet.css';
import { useTheme } from '../contexts/ThemeContext';
import { tileLayerFor } from '../utils/mapTiles';

// Office table + resolver live in utils/officeLocations.js (mirrored on the
// backend so PATCH /visuals/agents/:id/location can say whether a value
// resolves). MAP_DEFAULT_VIEW is a viewport only — never a pin (QA 08-24 #1).
// Get initials from name (e.g., "Vahid Haeri" -> "VH")
const getInitials = (name) => {
  const parts = name.split(' ').filter(p => p.length > 0);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  } else if (parts.length === 1) {
    return parts[0].substring(0, 2).toUpperCase();
  }
  return '??';
};

// Create custom marker icon with agent photo or initials
const createAgentIcon = (agent, isManager, scale = 1.0) => {
  // Base sizes
  const baseSize = isManager ? 50 : 40;
  const size = Math.round(baseSize * scale);
  
  const borderColor = isManager ? '#eab308' : '#3b82f6';
  const borderWidth = Math.max(1, Math.round((isManager ? 3 : 2) * scale));
  
  let iconHtml;
  
  // Check if photoUrl exists AND is not a placeholder or broken image
  // Skip base64 PNGs that are very small (likely blank/broken)
  const hasValidPhoto = agent.photoUrl && 
                        agent.photoUrl.length > 0 && 
                        !agent.photoUrl.includes('avatar_default') &&
                        !agent.photoUrl.includes('missing') &&
                        !(agent.photoUrl.startsWith('data:image/png;base64,iVBORw0KGgo') && agent.photoUrl.length < 5000);

  if (hasValidPhoto) {
    iconHtml = `
      <div style="
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        border: ${borderWidth}px solid ${borderColor};
        overflow: hidden;
        background: hsl(var(--card));
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        position: relative;
      ">
        <img 
          src="${agent.photoUrl}" 
          alt="${agent.name}"
          style="width: 100%; height: 100%; object-fit: cover;"
        />
      </div>
    `;
  } else {
    const initials = getInitials(agent.name);
    iconHtml = `
      <div style="
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        border: ${borderWidth}px solid ${borderColor};
        background: #3b82f6;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: bold;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: ${Math.round(size * 0.4)}px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        position: relative;
      ">
        ${initials}
      </div>
    `;
  }
  
  return divIcon({
    html: iconHtml,
    className: 'custom-agent-marker',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

// Component to fit map bounds to all visible markers
function FitBounds({ bounds }) {
  const map = useMap();
  
  useEffect(() => {
    if (bounds && bounds.length > 0) {
      // Use requestAnimationFrame to ensure map is fully rendered
      requestAnimationFrame(() => {
        try {
          map.fitBounds(bounds, { 
            padding: [80, 80], 
            maxZoom: 11,
            animate: true,
            duration: 0.5,
          });
        } catch (err) {
          console.error('Error fitting bounds:', err);
        }
      });
    } else {
      // Nothing resolvable: rest on the default viewport (a view, not a pin).
      map.setView([MAP_DEFAULT_VIEW.lat, MAP_DEFAULT_VIEW.lng], MAP_DEFAULT_VIEW.zoom);
    }
  }, [JSON.stringify(bounds), map]);
  
  return null;
}

export default function Visuals() {
  // Dark mode (DM9): swap the daylight OSM raster for CARTO dark_matter.
  const { resolvedTheme } = useTheme();
  const tiles = tileLayerFor(resolvedTheme);
  const navigate = useNavigate();
  const [agents, setAgents] = useState([]);
  const [selectedAgents, setSelectedAgents] = useState(new Set());
  const [managerId, setManagerId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [editingLocationId, setEditingLocationId] = useState(null);
  const [editingLocationValue, setEditingLocationValue] = useState('');
  const [isCustomLocation, setIsCustomLocation] = useState(false);
  // Post-save feedback for the location editor: { agentId, resolved, text }.
  // Shown inline under the agent's location line until the next edit.
  const [locationNotice, setLocationNotice] = useState(null);
  const [radiusScale, setRadiusScale] = useState(1.0); // Manual radius multiplier
  const [bubbleScale, setBubbleScale] = useState(1.0); // Manual bubble size multiplier

  // Fetch agents on mount
  useEffect(() => {
    const fetchAgents = async () => {
      try {
        setLoading(true);
        const response = await visualsAPI.getAgents();
        const agentsData = response.data.agents;
        setAgents(agentsData);
        
        // Load saved selections from database
        const savedSelectedIds = agentsData
          .filter(a => a.showOnMap)
          .map(a => a.id);
        setSelectedAgents(new Set(savedSelectedIds));
        
        // Load saved manager from database
        const savedManager = agentsData.find(a => a.isMapManager);
        if (savedManager) {
          setManagerId(savedManager.id);
        }
        
        setError(null);
      } catch (err) {
        console.error('Failed to fetch agents:', err);
        setError('Failed to load agents');
      } finally {
        setLoading(false);
      }
    };

    fetchAgents();
  }, []);

  // Save selections to database
  const saveSelections = async (newSelectedIds, newManagerId) => {
    try {
      await visualsAPI.batchUpdateVisibility(
        Array.from(newSelectedIds),
        newManagerId,
      );
    } catch (err) {
      console.error('Failed to save selections:', err);
    }
  };

  // Toggle agent selection
  const toggleAgent = (agentId) => {
    const newSelected = new Set(selectedAgents);
    let newManagerId = managerId;
    
    if (newSelected.has(agentId)) {
      newSelected.delete(agentId);
      // If deselecting the manager, unset manager
      if (managerId === agentId) {
        newManagerId = null;
        setManagerId(null);
      }
    } else {
      newSelected.add(agentId);
    }
    setSelectedAgents(newSelected);
    
    // Save to database
    saveSelections(newSelected, newManagerId);
  };

  // Set/unset manager
  const toggleManager = (agentId) => {
    let newManagerId;
    if (managerId === agentId) {
      newManagerId = null;
      setManagerId(null);
    } else {
      newManagerId = agentId;
      setManagerId(agentId);
      
      // Ensure manager is selected
      if (!selectedAgents.has(agentId)) {
        const newSelected = new Set(selectedAgents);
        newSelected.add(agentId);
        setSelectedAgents(newSelected);
        saveSelections(newSelected, newManagerId);
        return;
      }
    }
    
    // Save to database
    saveSelections(selectedAgents, newManagerId);
  };

  // Start editing location
  const startEditingLocation = (agentId, currentLocation) => {
    setEditingLocationId(agentId);
    setLocationNotice(null);
    // A value that resolves to a preset city opens the dropdown on it
    // ("Santiago, Chile" → Santiago); any other existing text opens the
    // custom input prefilled so a typo can be corrected rather than retyped.
    const hit = resolveLocation(currentLocation);
    if (hit && hit.kind === 'city' && PRESET_LOCATIONS.includes(hit.key)) {
      setIsCustomLocation(false);
      setEditingLocationValue(hit.key);
    } else if (currentLocation) {
      setIsCustomLocation(true);
      setEditingLocationValue(currentLocation);
    } else {
      setIsCustomLocation(false);
      setEditingLocationValue('');
    }
  };

  // Scroll the agent's card into view and open its editor (tray → card).
  const editFromTray = (agent) => {
    startEditingLocation(agent.id, agent.location);
    requestAnimationFrame(() => {
      document.getElementById(`visuals-agent-${agent.id}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    });
  };

  // Save location
  const saveLocation = async (agentId) => {
    try {
      const response = await visualsAPI.updateAgentLocation(agentId, editingLocationValue.trim());
      const data = response?.data || {};
      const savedLocation = data.location !== undefined ? data.location : (editingLocationValue.trim() || null);
      const resolved = data.resolved !== undefined ? Boolean(data.resolved) : Boolean(resolveLocation(savedLocation));

      setAgents(agents.map(agent =>
        agent.id === agentId
          ? { ...agent, location: savedLocation }
          : agent,
      ));
      setLocationNotice(savedLocation && !resolved
        ? { agentId, resolved: false, text: UNRESOLVED_LOCATION_HINT }
        : null);

      setEditingLocationId(null);
      setEditingLocationValue('');
      setIsCustomLocation(false);
    } catch (err) {
      console.error('Failed to update location:', err);
      const message = err?.response?.data?.message || 'Failed to update location';
      setLocationNotice({ agentId, resolved: false, text: message });
    }
  };

  // Cancel editing
  const cancelEditingLocation = () => {
    setEditingLocationId(null);
    setEditingLocationValue('');
    setIsCustomLocation(false);
  };


  // Group selected agents by RESOLVED location. Agents whose location is
  // unset or unrecognized go to `unplaced` (sidebar tray) — never a marker.
  const getAgentsByLocation = () => {
    const grouped = {};
    const unplaced = [];

    agents.forEach(agent => {
      if (!selectedAgents.has(agent.id)) return;

      const hit = resolveLocation(agent.location);
      if (!hit) {
        unplaced.push(agent);
        return;
      }
      if (!grouped[hit.key]) {
        grouped[hit.key] = { coords: hit, agents: [] };
      }
      grouped[hit.key].agents.push(agent);
    });

    return { grouped, unplaced };
  };

  // Calculate positions for agents in a circle (for Vancouver clustering)
  const getCirclePositions = (center, agentsList) => {
    if (agentsList.length === 0) return [];
    if (agentsList.length === 1) {
      return [{ ...agentsList[0], lat: center.lat, lng: center.lng }];
    }

    const positions = [];
    const angleStep = (2 * Math.PI) / agentsList.length;
    
    // Use manual radius scale
    // Base 0.1 degrees (~10km) * manual scale * sqrt(count)
    const radius = 0.1 * radiusScale * Math.sqrt(agentsList.length);
    
    agentsList.forEach((agent, index) => {
      const angle = index * angleStep;
      const lat = center.lat + radius * Math.cos(angle);
      const lng = center.lng + radius * Math.sin(angle);
      positions.push({ ...agent, lat, lng });
    });
    
    return positions;
  };

  // Get all markers for the map
  const getMarkers = () => {
    const markers = [];
    const { grouped } = getAgentsByLocation();

    Object.values(grouped).forEach(({ coords: officeCoords, agents: locationAgents }) => {
      
      // Check if this location has the manager
      const managerInLocation = locationAgents.find(a => a.id === managerId);
      const nonManagerAgents = locationAgents.filter(a => a.id !== managerId);
      
      // For Vancouver (or any location with multiple agents), arrange in circle
      if (locationAgents.length > 1) {
        // If there's a manager, put them in center and arrange others around
        if (managerInLocation) {
          // Manager in center
          markers.push({
            ...managerInLocation,
            lat: officeCoords.lat,
            lng: officeCoords.lng,
            isManager: true,
          });
          
          // Others in circle around manager
          if (nonManagerAgents.length > 0) {
            const circlePositions = getCirclePositions(officeCoords, nonManagerAgents);
            markers.push(...circlePositions.map(pos => ({ ...pos, isManager: false })));
          }
        } else {
          // No manager, arrange all in circle
          const circlePositions = getCirclePositions(officeCoords, locationAgents);
          markers.push(...circlePositions.map(pos => ({ ...pos, isManager: false })));
        }
      } else if (locationAgents.length === 1) {
        // Single agent at exact office location
        markers.push({
          ...locationAgents[0],
          lat: officeCoords.lat,
          lng: officeCoords.lng,
          isManager: locationAgents[0].id === managerId,
        });
      }
    });
    
    return markers;
  };

  const markers = getMarkers();
  const unplacedAgents = getAgentsByLocation().unplaced
    .sort((a, b) => a.name.localeCompare(b.name));
  
  // Calculate bounds for all markers
  const bounds = markers.length > 0
    ? markers.map(m => [m.lat, m.lng])
    : null;
  
  // Create a key to force map update when markers change
  const mapKey = `${markers.length}-${selectedAgents.size}-${managerId || 'none'}-${radiusScale}-${bubbleScale}`;

  return (
    <>
      <style>{`
        .custom-agent-marker {
          background: transparent !important;
          border: none !important;
        }
        .fallback-initials {
          background: #3b82f6 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          color: white !important;
          font-weight: bold !important;
        }
      `}</style>
      <div className="min-h-screen bg-muted flex flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0 md:pl-[58px]">
        {/* Header */}
        <header className="bg-card shadow-sm border-b border-border">
          <div className="max-w-7xl mx-auto px-3 py-3 sm:px-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  onClick={() => navigate('/dashboard')}
                  className="min-h-[40px] min-w-[40px] p-2 hover:bg-muted rounded-lg transition-colors"
                  title="Back to Dashboard"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h1 className="min-w-0 truncate text-lg font-bold text-foreground sm:text-2xl">Agent Maps</h1>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:items-center lg:gap-4">
                {/* Radius Scale Slider */}
                <div className="flex min-w-0 items-center gap-2 bg-muted/50 px-3 py-2 lg:py-1.5 rounded-lg border border-border">
                  <Maximize className="w-4 h-4 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col lg:w-32 lg:flex-none">
                    <label className="text-[10px] text-muted-foreground font-medium leading-none mb-1">Spread Radius</label>
                    <input
                      type="range"
                      min="0.1"
                      max="10.0"
                      step="0.1"
                      value={radiusScale}
                      onChange={(e) => setRadiusScale(parseFloat(e.target.value))}
                      className="w-full h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-blue-600"
                      title={`Radius Scale: ${radiusScale}x`}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground font-medium w-8 text-right">{radiusScale.toFixed(1)}x</span>
                </div>

                {/* Bubble Size Slider */}
                <div className="flex min-w-0 items-center gap-2 bg-muted/50 px-3 py-2 lg:py-1.5 rounded-lg border border-border">
                  <div className="w-4 h-4 flex items-center justify-center text-muted-foreground">
                    <div className="w-3 h-3 rounded-full border-2 border-current"></div>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col lg:w-32 lg:flex-none">
                    <label className="text-[10px] text-muted-foreground font-medium leading-none mb-1">Bubble Size</label>
                    <input
                      type="range"
                      min="0.5"
                      max="2.0"
                      step="0.1"
                      value={bubbleScale}
                      onChange={(e) => setBubbleScale(parseFloat(e.target.value))}
                      className="w-full h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-blue-600"
                      title={`Bubble Scale: ${bubbleScale}x`}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground font-medium w-8 text-right">{bubbleScale.toFixed(1)}x</span>
                </div>

                <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground sm:col-span-2 lg:border-0 lg:bg-transparent lg:px-0 lg:py-0">
                  <Users className="w-4 h-4" />
                  <span>{selectedAgents.size} of {agents.length} agents selected</span>
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden lg:flex-row">
          {/* Sidebar - Agent List */}
          <div className={`bg-card border-b border-border overflow-y-auto transition-all duration-300 lg:border-b-0 lg:border-r ${
            sidebarCollapsed ? 'max-h-24 lg:max-h-none lg:w-20' : 'max-h-[42vh] lg:max-h-none lg:w-80'
          }`}>
            <div className={`p-3 sm:p-4 ${sidebarCollapsed ? 'lg:px-2' : ''}`}>
              {/* Header with Collapse Toggle */}
              <div className="flex items-center justify-between mb-4">
                {!sidebarCollapsed && (
                  <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                    <Users className="w-5 h-5" />
                  Agents
                  </h2>
                )}
                <button
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  className="p-2 hover:bg-muted rounded-lg transition-colors"
                  title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                  {sidebarCollapsed ? (
                    <ChevronRight className="w-5 h-5" />
                  ) : (
                    <ChevronLeft className="w-5 h-5" />
                  )}
                </button>
              </div>

              {loading && (
                <div className="flex items-center justify-center py-8">
                  <Loader className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-300" />
                </div>
              )}

              {error && (
                <div className="bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg p-3 mb-4">
                  <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
                </div>
              )}

              {!loading && !error && (
                <>
                  {/* Select/Deselect All */}
                  {!sidebarCollapsed && (
                    <div className="mb-4 pb-4 border-b border-border">
                      <button
                        onClick={() => {
                          let newSelected;
                          let newManagerId = managerId;
                        
                          if (selectedAgents.size === agents.length) {
                            newSelected = new Set();
                            newManagerId = null;
                            setSelectedAgents(newSelected);
                            setManagerId(null);
                          } else {
                            newSelected = new Set(agents.map(a => a.id));
                            setSelectedAgents(newSelected);
                          }
                        
                          // Save to database
                          saveSelections(newSelected, newManagerId);
                        }}
                        className="w-full px-3 py-2 text-sm font-medium text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/15 rounded-lg transition-colors"
                      >
                        {selectedAgents.size === agents.length ? 'Deselect All' : 'Select All'}
                      </button>
                    </div>
                  )}

                  {/* Unplaced tray (QA 08-24 #1): selected agents with no
                      or an unrecognized location. They used to get a fake
                      pin at the Canada centroid; now they wait here with a
                      direct path to the editor. */}
                  {!sidebarCollapsed && unplacedAgents.length > 0 && (
                    <section
                      aria-label={`Location not set / unrecognized (${unplacedAgents.length})`}
                      className="mb-4 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/10 p-2.5"
                    >
                      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
                        <MapPinOff className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                        <span className="truncate">Location not set / unrecognized ({unplacedAgents.length})</span>
                      </h3>
                      <p className="mt-0.5 text-[11px] leading-snug text-amber-800/80">Not on the map until a known city or lat,lng is set.</p>
                      <ul className="mt-2 space-y-1">
                        {unplacedAgents.map((agent) => (
                          <li key={agent.id} className="flex items-center gap-2 rounded-md bg-card/70 px-1.5 py-1">
                            {agent.photoUrl ? (
                              <img src={agent.photoUrl} alt="" className="h-6 w-6 shrink-0 rounded-full border border-border object-cover" />
                            ) : (
                              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600" aria-hidden="true">
                                <span className="text-[9px] font-bold text-white">{getInitials(agent.name)}</span>
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium text-foreground">{agent.name}</p>
                              <p className="truncate text-[11px] text-muted-foreground">
                                {agent.location ? <>Unrecognized: <span className="text-foreground/85">{agent.location}</span></> : 'Not set'}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => editFromTray(agent)}
                              className="tp-focus-ring shrink-0 rounded-md border border-amber-300 dark:border-amber-500/40 bg-card px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/20"
                              aria-label={`Edit location for ${agent.name}`}
                            >
                              Edit location
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {/* Agent List */}
                  <div className={`${sidebarCollapsed ? 'flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0' : 'space-y-2'}`}>
                    {agents
                      .sort((a, b) => {
                      // Sort: selected first, then by name
                        const aSelected = selectedAgents.has(a.id);
                        const bSelected = selectedAgents.has(b.id);
                        if (aSelected === bSelected) {
                          return a.name.localeCompare(b.name);
                        }
                        return bSelected ? 1 : -1;
                      })
                      .map(agent => {
                        const isSelected = selectedAgents.has(agent.id);
                        const isManager = managerId === agent.id;
                    
                        if (sidebarCollapsed) {
                          // Compact view - just initials/photo
                          return (
                            <div
                              key={agent.id}
                              onClick={() => toggleAgent(agent.id)}
                              className={`relative flex-shrink-0 cursor-pointer transition-all ${
                                isManager ? 'ring-2 ring-yellow-400 rounded-full' : ''
                              }`}
                              title={`${agent.name} - ${agent.location || 'No location'}`}
                            >
                              {agent.photoUrl ? (
                                <img
                                  src={agent.photoUrl}
                                  alt={agent.name}
                                  className={`w-12 h-12 rounded-full object-cover border-2 ${
                                    isSelected ? 'border-blue-500' : 'border-input'
                                  }`}
                                />
                              ) : (
                                <div className={`w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center border-2 ${
                                  isSelected ? 'border-blue-400' : 'border-input'
                                }`}>
                                  <span className="text-xs font-bold text-white">
                                    {getInitials(agent.name)}
                                  </span>
                                </div>
                              )}
                              {/* Selected indicator */}
                              {isSelected && (
                                <div className="absolute -top-1 -right-1 w-4 h-4 bg-blue-600 rounded-full border-2 border-card flex items-center justify-center">
                                  <span className="text-white text-xs">✓</span>
                                </div>
                              )}
                              {/* Manager crown */}
                              {isManager && (
                                <div className="absolute -bottom-1 left-1/2 -translate-x-1/2">
                                  <Crown className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                                </div>
                              )}
                            </div>
                          );
                        }
                    
                        // Full view
                        return (
                          <div
                            key={agent.id}
                            id={`visuals-agent-${agent.id}`}
                            className={`border rounded-lg p-2 transition-all ${
                              isSelected
                                ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15'
                                : 'border-border bg-card'
                            } ${isManager ? 'ring-2 ring-yellow-400' : ''}`}
                          >
                            <div className="flex items-start gap-2">
                              {/* Checkbox */}
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleAgent(agent.id)}
                                className="mt-1 w-3.5 h-3.5 text-blue-600 dark:text-blue-300 rounded focus:ring-blue-500"
                              />

                              {/* Photo or Initials */}
                              <div className="flex-shrink-0">
                                {agent.photoUrl ? (
                                  <img
                                    src={agent.photoUrl}
                                    alt={agent.name}
                                    className="w-10 h-10 rounded-full object-cover border-2 border-input"
                                  />
                                ) : (
                                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center border-2 border-blue-400">
                                    <span className="text-xs font-bold text-white">
                                      {getInitials(agent.name)}
                                    </span>
                                  </div>
                                )}
                              </div>

                              {/* Info */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1">
                                  <h3 className="text-sm font-semibold text-foreground truncate">
                                    {agent.name}
                                  </h3>
                                  {isManager && (
                                    <Crown className="w-3.5 h-3.5 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground truncate">{agent.email}</p>
                            
                                {/* Location Editor */}
                                {editingLocationId === agent.id ? (
                                  <div className="mt-1 space-y-1">
                                    {/* Dropdown or Custom Input */}
                                    {isCustomLocation ? (
                                      <div className="flex items-center gap-1">
                                        <input
                                          type="text"
                                          value={editingLocationValue}
                                          onChange={(e) => setEditingLocationValue(e.target.value)}
                                          placeholder="City or lat,lng"
                                          aria-label="Custom location (city name or lat,lng)"
                                          className="flex-1 px-2 py-1 text-xs border border-blue-300 dark:border-blue-500/40 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                                          autoFocus
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') saveLocation(agent.id);
                                            if (e.key === 'Escape') cancelEditingLocation();
                                          }}
                                        />
                                        <button
                                          onClick={() => saveLocation(agent.id)}
                                          className="p-1 bg-green-500 text-white rounded hover:bg-green-600"
                                          title="Save"
                                        >
                                          <Check className="w-3 h-3" />
                                        </button>
                                        <button
                                          onClick={cancelEditingLocation}
                                          className="p-1 bg-muted-foreground/40 text-foreground/85 rounded hover:bg-muted-foreground/60"
                                          title="Cancel"
                                        >
                                          <X className="w-3 h-3" />
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-1">
                                        <select
                                          value={editingLocationValue}
                                          onChange={(e) => {
                                            const value = e.target.value;
                                            if (value === 'custom') {
                                              setIsCustomLocation(true);
                                              setEditingLocationValue('');
                                            } else {
                                              setEditingLocationValue(value);
                                            }
                                          }}
                                          className="flex-1 px-2 py-1 text-xs border border-blue-300 dark:border-blue-500/40 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                                          autoFocus
                                        >
                                          <option value="">Select location...</option>
                                          {PRESET_LOCATIONS.map(loc => (
                                            <option key={loc} value={loc}>{loc}</option>
                                          ))}
                                          <option value="custom">Custom...</option>
                                        </select>
                                        <button
                                          onClick={() => saveLocation(agent.id)}
                                          className="p-1 bg-green-500 text-white rounded hover:bg-green-600"
                                          title="Save"
                                          disabled={!editingLocationValue}
                                        >
                                          <Check className="w-3 h-3" />
                                        </button>
                                        <button
                                          onClick={cancelEditingLocation}
                                          className="p-1 bg-muted-foreground/40 text-foreground/85 rounded hover:bg-muted-foreground/60"
                                          title="Cancel"
                                        >
                                          <X className="w-3 h-3" />
                                        </button>
                                      </div>
                                    )}
                                    {isCustomLocation && (() => {
                                      const value = editingLocationValue.trim();
                                      if (!value) return null;
                                      const hit = resolveLocation(value);
                                      return hit ? (
                                        <p className="text-[11px] text-emerald-700 dark:text-emerald-200" role="status">
                                          Pins at {hit.kind === 'coords' ? hit.key : `${hit.key} (${hit.lat}, ${hit.lng})`}
                                        </p>
                                      ) : (
                                        <p className="flex items-start gap-1 text-[11px] text-amber-800 dark:text-amber-200" role="status">
                                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                                          <span>{UNRESOLVED_LOCATION_HINT}</span>
                                        </p>
                                      );
                                    })()}
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1 mt-0.5">
                                    <p className="text-xs text-muted-foreground flex-1">
                                      {agent.location || 'No location'}
                                    </p>
                                    <button
                                      onClick={() => startEditingLocation(agent.id, agent.location)}
                                      className="p-0.5 hover:bg-secondary rounded"
                                      title="Edit location"
                                      aria-label={`Edit location for ${agent.name}`}
                                    >
                                      <Edit2 className="w-3 h-3 text-muted-foreground/75" />
                                    </button>
                                  </div>
                                )}
                                {locationNotice && locationNotice.agentId === agent.id && editingLocationId !== agent.id && (
                                  <p className="mt-1 flex items-start gap-1 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-1.5 py-1 text-[11px] leading-snug text-amber-900 dark:text-amber-200" role="alert">
                                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                                    <span>{locationNotice.text}</span>
                                  </p>
                                )}

                                {/* Manager Checkbox */}
                                <label className="flex items-center gap-1.5 mt-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={isManager}
                                    onChange={() => toggleManager(agent.id)}
                                    disabled={!isSelected}
                                    className="w-3 h-3 text-yellow-500 rounded focus:ring-yellow-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                  />
                                  <span className={`text-xs ${isSelected ? 'text-foreground/85' : 'text-muted-foreground/75'}`}>
                                Manager
                                  </span>
                                </label>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Map Container */}
          <div className="relative min-h-[55vh] flex-1 lg:min-h-0">
            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center bg-muted/50">
                <div className="text-center">
                  <Activity className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600 dark:text-blue-300" />
                  <p className="text-muted-foreground">Loading map...</p>
                </div>
              </div>
            ) : error ? (
              <div className="absolute inset-0 flex items-center justify-center bg-muted/50">
                <div className="text-center">
                  <p className="text-red-600 dark:text-red-300 font-semibold mb-2">Error loading map</p>
                  <p className="text-muted-foreground">{error}</p>
                </div>
              </div>
            ) : selectedAgents.size === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center bg-muted/50">
                <div className="text-center">
                  <Users className="w-16 h-16 mx-auto mb-4 text-muted-foreground/75" />
                  <p className="text-muted-foreground font-medium">No agents selected</p>
                  <p className="text-sm text-muted-foreground mt-1">Select agents from the sidebar to view them on the map</p>
                </div>
              </div>
            ) : (
              <MapContainer
                key={mapKey}
                center={[MAP_DEFAULT_VIEW.lat, MAP_DEFAULT_VIEW.lng]}
                zoom={MAP_DEFAULT_VIEW.zoom}
                className="h-full min-h-[55vh] w-full lg:min-h-0"
                scrollWheelZoom={true}
                zoomSnap={0.1} // Allow finer zoom steps
                zoomDelta={0.5} // Smaller zoom increments (was 1)
                wheelPxPerZoomLevel={120} // Slower wheel zoom
              >
                {/* Keyed on the url: react-leaflet tile-layer props are
                    immutable after mount, so the theme swap must remount. */}
                <TileLayer
                  key={tiles.url}
                  attribution={tiles.attribution}
                  url={tiles.url}
                  {...(tiles.subdomains ? { subdomains: tiles.subdomains } : {})}
                  maxZoom={tiles.maxZoom}
                />
                {tiles.referenceUrl && (
                  <TileLayer key={tiles.referenceUrl} url={tiles.referenceUrl} maxZoom={tiles.maxZoom} />
                )}
              
                <FitBounds bounds={bounds} />

                {markers.map((marker, index) => (
                  <Marker
                    key={`${marker.id}-${index}`}
                    position={[marker.lat, marker.lng]}
                    icon={createAgentIcon(marker, marker.isManager, bubbleScale)}
                  >
                    <Popup>
                      <div className="p-2 min-w-[200px]">
                        <div className="flex items-center gap-2 mb-2">
                          {marker.photoUrl ? (
                            <img
                              src={marker.photoUrl}
                              alt={marker.name}
                              className="w-12 h-12 rounded-full object-cover"
                            />
                          ) : (
                            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
                              <span className="text-sm font-bold text-white">
                                {getInitials(marker.name)}
                              </span>
                            </div>
                          )}
                          <div className="flex-1">
                            <div className="flex items-center gap-1">
                              <h3 className="font-semibold text-foreground">{marker.name}</h3>
                              {marker.isManager && (
                                <Crown className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">{marker.email}</p>
                          </div>
                        </div>
                        <div className="text-sm text-foreground/85">
                          <p><strong>Location:</strong> {marker.location || 'Not set'}</p>
                          {marker.isManager && (
                            <p className="mt-1 text-yellow-700 dark:text-yellow-200 font-medium">Manager</p>
                          )}
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            )}
          </div>
        </div>
        <MobileTabBar />
        <SideRail />
      </div>
    </>
  );
}
