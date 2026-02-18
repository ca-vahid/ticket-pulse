import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { divIcon } from 'leaflet';
import { visualsAPI } from '../services/api';
import { ArrowLeft, Users, Crown, Activity, Loader, ChevronLeft, ChevronRight, Edit2, Check, X, Maximize } from 'lucide-react';
import 'leaflet/dist/leaflet.css';

// Office locations (lat/lng coordinates)
const OFFICE_LOCATIONS = {
  Vancouver: { lat: 49.2827, lng: -123.1207, zoom: 10 },
  Calgary: { lat: 51.0447, lng: -114.0719, zoom: 10 },
  Ottawa: { lat: 45.4215, lng: -75.6972, zoom: 10 },
  Halifax: { lat: 44.6488, lng: -63.5752, zoom: 10 },
  Toronto: { lat: 43.6532, lng: -79.3832, zoom: 10 },
  Default: { lat: 54.5, lng: -105.0, zoom: 4 }, // Center of Canada
};

// Preset location options
const PRESET_LOCATIONS = ['Vancouver', 'Calgary', 'Ottawa', 'Toronto', 'Halifax'];

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
        background: white;
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
      // If no markers, show full Canada view
      map.setView([54.5, -105.0], 4);
    }
  }, [JSON.stringify(bounds), map]);
  
  return null;
}

export default function Visuals() {
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
      console.log('Saving selections:', {
        selectedIds: Array.from(newSelectedIds),
        managerId: newManagerId,
      });
      await visualsAPI.batchUpdateVisibility(
        Array.from(newSelectedIds),
        newManagerId,
      );
      console.log('Selections saved successfully');
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
    // Always start with dropdown (not custom mode)
    setIsCustomLocation(false);
    // If current location is in presets, select it; otherwise leave empty
    const isPreset = PRESET_LOCATIONS.includes(currentLocation);
    setEditingLocationValue(isPreset ? currentLocation : '');
  };

  // Save location
  const saveLocation = async (agentId) => {
    try {
      await visualsAPI.updateAgentLocation(agentId, editingLocationValue);
      
      // Update local state
      setAgents(agents.map(agent => 
        agent.id === agentId 
          ? { ...agent, location: editingLocationValue }
          : agent,
      ));
      
      setEditingLocationId(null);
      setEditingLocationValue('');
      setIsCustomLocation(false);
    } catch (err) {
      console.error('Failed to update location:', err);
      alert('Failed to update location');
    }
  };

  // Cancel editing
  const cancelEditingLocation = () => {
    setEditingLocationId(null);
    setEditingLocationValue('');
    setIsCustomLocation(false);
  };


  // Group agents by location
  const getAgentsByLocation = () => {
    const grouped = {};
    
    agents.forEach(agent => {
      if (!selectedAgents.has(agent.id)) return;
      
      const location = agent.location || 'Unknown';
      if (!grouped[location]) {
        grouped[location] = [];
      }
      grouped[location].push(agent);
    });
    
    return grouped;
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
    const agentsByLocation = getAgentsByLocation();
    
    Object.entries(agentsByLocation).forEach(([location, locationAgents]) => {
      const officeCoords = OFFICE_LOCATIONS[location] || OFFICE_LOCATIONS.Default;
      
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
      <div className="min-h-screen bg-gray-100 flex flex-col">
        {/* Header */}
        <header className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => navigate('/dashboard')}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                  title="Back to Dashboard"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h1 className="text-2xl font-bold text-gray-800">Agent Map Visualization</h1>
              </div>
              <div className="flex items-center gap-4">
                {/* Radius Scale Slider */}
                <div className="flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200">
                  <Maximize className="w-4 h-4 text-gray-500" />
                  <div className="flex flex-col w-32">
                    <label className="text-[10px] text-gray-500 font-medium leading-none mb-1">Spread Radius</label>
                    <input
                      type="range"
                      min="0.1"
                      max="10.0"
                      step="0.1"
                      value={radiusScale}
                      onChange={(e) => setRadiusScale(parseFloat(e.target.value))}
                      className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                      title={`Radius Scale: ${radiusScale}x`}
                    />
                  </div>
                  <span className="text-xs text-gray-600 font-medium w-8 text-right">{radiusScale.toFixed(1)}x</span>
                </div>

                {/* Bubble Size Slider */}
                <div className="flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200">
                  <div className="w-4 h-4 flex items-center justify-center text-gray-500">
                    <div className="w-3 h-3 rounded-full border-2 border-current"></div>
                  </div>
                  <div className="flex flex-col w-32">
                    <label className="text-[10px] text-gray-500 font-medium leading-none mb-1">Bubble Size</label>
                    <input
                      type="range"
                      min="0.5"
                      max="2.0"
                      step="0.1"
                      value={bubbleScale}
                      onChange={(e) => setBubbleScale(parseFloat(e.target.value))}
                      className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                      title={`Bubble Scale: ${bubbleScale}x`}
                    />
                  </div>
                  <span className="text-xs text-gray-600 font-medium w-8 text-right">{bubbleScale.toFixed(1)}x</span>
                </div>

                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Users className="w-4 h-4" />
                  <span>{selectedAgents.size} of {agents.length} agents selected</span>
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar - Agent List */}
          <div className={`bg-white border-r border-gray-200 overflow-y-auto transition-all duration-300 ${
            sidebarCollapsed ? 'w-20' : 'w-80'
          }`}>
            <div className={`p-4 ${sidebarCollapsed ? 'px-2' : ''}`}>
              {/* Header with Collapse Toggle */}
              <div className="flex items-center justify-between mb-4">
                {!sidebarCollapsed && (
                  <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                    <Users className="w-5 h-5" />
                  Agents
                  </h2>
                )}
                <button
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
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
                  <Loader className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              )}

              {!loading && !error && (
                <>
                  {/* Select/Deselect All */}
                  {!sidebarCollapsed && (
                    <div className="mb-4 pb-4 border-b border-gray-200">
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
                        className="w-full px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                      >
                        {selectedAgents.size === agents.length ? 'Deselect All' : 'Select All'}
                      </button>
                    </div>
                  )}

                  {/* Agent List */}
                  <div className={`space-y-2 ${sidebarCollapsed ? 'space-y-1' : ''}`}>
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
                              className={`relative cursor-pointer transition-all ${
                                isManager ? 'ring-2 ring-yellow-400 rounded-full' : ''
                              }`}
                              title={`${agent.name} - ${agent.location || 'No location'}`}
                            >
                              {agent.photoUrl ? (
                                <img
                                  src={agent.photoUrl}
                                  alt={agent.name}
                                  className={`w-12 h-12 rounded-full object-cover border-2 ${
                                    isSelected ? 'border-blue-500' : 'border-gray-300'
                                  }`}
                                />
                              ) : (
                                <div className={`w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center border-2 ${
                                  isSelected ? 'border-blue-400' : 'border-gray-400'
                                }`}>
                                  <span className="text-xs font-bold text-white">
                                    {getInitials(agent.name)}
                                  </span>
                                </div>
                              )}
                              {/* Selected indicator */}
                              {isSelected && (
                                <div className="absolute -top-1 -right-1 w-4 h-4 bg-blue-600 rounded-full border-2 border-white flex items-center justify-center">
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
                            className={`border rounded-lg p-2 transition-all ${
                              isSelected
                                ? 'border-blue-300 bg-blue-50'
                                : 'border-gray-200 bg-white'
                            } ${isManager ? 'ring-2 ring-yellow-400' : ''}`}
                          >
                            <div className="flex items-start gap-2">
                              {/* Checkbox */}
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleAgent(agent.id)}
                                className="mt-1 w-3.5 h-3.5 text-blue-600 rounded focus:ring-blue-500"
                              />

                              {/* Photo or Initials */}
                              <div className="flex-shrink-0">
                                {agent.photoUrl ? (
                                  <img
                                    src={agent.photoUrl}
                                    alt={agent.name}
                                    className="w-10 h-10 rounded-full object-cover border-2 border-gray-300"
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
                                  <h3 className="text-sm font-semibold text-gray-900 truncate">
                                    {agent.name}
                                  </h3>
                                  {isManager && (
                                    <Crown className="w-3.5 h-3.5 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                                  )}
                                </div>
                                <p className="text-xs text-gray-600 truncate">{agent.email}</p>
                            
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
                                          placeholder="Enter custom location"
                                          className="flex-1 px-2 py-1 text-xs border border-blue-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                                          className="p-1 bg-gray-300 text-gray-700 rounded hover:bg-gray-400"
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
                                          className="flex-1 px-2 py-1 text-xs border border-blue-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                                          className="p-1 bg-gray-300 text-gray-700 rounded hover:bg-gray-400"
                                          title="Cancel"
                                        >
                                          <X className="w-3 h-3" />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1 mt-0.5">
                                    <p className="text-xs text-gray-500 flex-1">
                                      {agent.location || 'No location'}
                                    </p>
                                    <button
                                      onClick={() => startEditingLocation(agent.id, agent.location)}
                                      className="p-0.5 hover:bg-gray-200 rounded"
                                      title="Edit location"
                                    >
                                      <Edit2 className="w-3 h-3 text-gray-400" />
                                    </button>
                                  </div>
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
                                  <span className={`text-xs ${isSelected ? 'text-gray-700' : 'text-gray-400'}`}>
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
          <div className="flex-1 relative">
            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                <div className="text-center">
                  <Activity className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
                  <p className="text-gray-600">Loading map...</p>
                </div>
              </div>
            ) : error ? (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                <div className="text-center">
                  <p className="text-red-600 font-semibold mb-2">Error loading map</p>
                  <p className="text-gray-600">{error}</p>
                </div>
              </div>
            ) : markers.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                <div className="text-center">
                  <Users className="w-16 h-16 mx-auto mb-4 text-gray-400" />
                  <p className="text-gray-600 font-medium">No agents selected</p>
                  <p className="text-sm text-gray-500 mt-1">Select agents from the sidebar to view them on the map</p>
                </div>
              </div>
            ) : (
              <MapContainer
                key={mapKey}
                center={[54.5, -105.0]}
                zoom={4}
                className="h-full w-full"
                scrollWheelZoom={true}
                zoomSnap={0.1} // Allow finer zoom steps
                zoomDelta={0.5} // Smaller zoom increments (was 1)
                wheelPxPerZoomLevel={120} // Slower wheel zoom
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
              
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
                              <h3 className="font-semibold text-gray-900">{marker.name}</h3>
                              {marker.isManager && (
                                <Crown className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                              )}
                            </div>
                            <p className="text-xs text-gray-600">{marker.email}</p>
                          </div>
                        </div>
                        <div className="text-sm text-gray-700">
                          <p><strong>Location:</strong> {marker.location || 'Not set'}</p>
                          {marker.isManager && (
                            <p className="mt-1 text-yellow-700 font-medium">Manager</p>
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
      </div>
    </>
  );
}

