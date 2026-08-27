/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Agent Map (QA 08-24 #1): unresolved / unset locations never become
// markers — they go to the sidebar tray with an Edit-location path — and an
// unrecognized save shows the inline "we don't know where that is" warning.
const { getAgentsSpy, updateLocationSpy } = vi.hoisted(() => ({
  getAgentsSpy: vi.fn(),
  updateLocationSpy: vi.fn(),
}));

vi.mock('../services/api', () => ({
  visualsAPI: {
    getAgents: getAgentsSpy,
    updateAgentLocation: updateLocationSpy,
    batchUpdateVisibility: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children, center, zoom }) => <div data-testid="map" data-center={center.join(',')} data-zoom={zoom}>{children}</div>,
  TileLayer: () => null,
  Marker: ({ position, children }) => <div data-testid="marker" data-position={position.join(',')}>{children}</div>,
  Popup: ({ children }) => <div>{children}</div>,
  useMap: () => ({ fitBounds: vi.fn(), setView: vi.fn() }),
}));
vi.mock('leaflet', () => ({ divIcon: (opts) => opts }));
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/nav/SideRail', () => ({ default: () => null }));

import Visuals from './Visuals';

const agent = (id, name, location, extra = {}) => ({
  id, name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, photoUrl: null,
  location, timezone: null, showOnMap: true, isMapManager: false, isActive: true, ...extra,
});

function mount() {
  return render(<MemoryRouter><Visuals /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  getAgentsSpy.mockResolvedValue({
    data: {
      agents: [
        agent(1, 'Victor Vega', 'Santiago, Chile'),
        agent(2, 'Nora Null', null),
        agent(3, 'Atlas Lost', 'Atlantis'),
        agent(4, 'Vera Van', 'vancouver'),
        agent(5, 'Hidden Hal', null, { showOnMap: false }),
      ],
    },
  });
});
afterEach(() => cleanup());

describe('Visuals — unplaced tray (MP3)', () => {
  test('unset + unrecognized agents land in the tray, not on the map; resolved ones pin (suffix + case tolerant)', async () => {
    mount();
    const tray = await screen.findByRole('region', { name: 'Location not set / unrecognized (2)' });
    expect(within(tray).getByText('Nora Null')).toBeInTheDocument();
    expect(within(tray).getByText('Not set')).toBeInTheDocument();
    expect(within(tray).getByText('Atlas Lost')).toBeInTheDocument();
    expect(within(tray).getByText('Atlantis')).toBeInTheDocument();
    // Deselected agents are not "waiting for the map".
    expect(within(tray).queryByText('Hidden Hal')).not.toBeInTheDocument();

    const markers = screen.getAllByTestId('marker');
    expect(markers).toHaveLength(2);
    const positions = markers.map((m) => m.getAttribute('data-position')).sort();
    expect(positions).toEqual(['-33.4489,-70.6693', '49.2827,-123.1207']);
    // Nobody sits on the old Saskatchewan fallback.
    expect(positions.some((p) => p.startsWith('54.5,'))).toBe(false);
    // The viewport default is still the Canada centroid — as a view.
    expect(screen.getByTestId('map')).toHaveAttribute('data-center', '54.5,-105');
  });

  test('map still renders (no markers) when every selected agent is unplaced', async () => {
    getAgentsSpy.mockResolvedValue({ data: { agents: [agent(2, 'Nora Null', null)] } });
    mount();
    await screen.findByRole('region', { name: 'Location not set / unrecognized (1)' });
    expect(screen.getByTestId('map')).toBeInTheDocument();
    expect(screen.queryAllByTestId('marker')).toHaveLength(0);
    expect(screen.queryByText('No agents selected')).not.toBeInTheDocument();
  });

  test('tray "Edit location" opens the card editor prefilled with the unrecognized text', async () => {
    mount();
    const tray = await screen.findByRole('region', { name: /Location not set/ });
    fireEvent.click(within(tray).getByRole('button', { name: 'Edit location for Atlas Lost' }));
    const input = screen.getByRole('textbox', { name: 'Custom location (city name or lat,lng)' });
    expect(input).toHaveValue('Atlantis');
    // Live hint while typing: unknown → warning, known → "Pins at".
    expect(screen.getByRole('status')).toHaveTextContent(/don't know where that is/);
    fireEvent.change(input, { target: { value: 'Santiago, Chile' } });
    expect(screen.getByRole('status')).toHaveTextContent('Pins at Santiago (-33.4489, -70.6693)');
    fireEvent.change(input, { target: { value: '-33.4,-70.6' } });
    expect(screen.getByRole('status')).toHaveTextContent('Pins at -33.4,-70.6');
  });
});

describe('Visuals — save feedback (MP4)', () => {
  test('resolved:false from PATCH → inline warning, agent stays in the tray', async () => {
    updateLocationSpy.mockResolvedValue({ data: { id: 2, name: 'Nora Null', location: 'Narnia', resolved: false, lat: null, lng: null } });
    mount();
    const tray = await screen.findByRole('region', { name: /Location not set/ });
    fireEvent.click(within(tray).getByRole('button', { name: 'Edit location for Nora Null' }));
    // Unset → dropdown first; switch to Custom…
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'custom' } });
    const input = screen.getByRole('textbox', { name: 'Custom location (city name or lat,lng)' });
    fireEvent.change(input, { target: { value: 'Narnia' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(updateLocationSpy).toHaveBeenCalledWith(2, 'Narnia'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/We don't know where that is — pick a nearby city or enter lat,lng/);
    expect(screen.getByRole('region', { name: 'Location not set / unrecognized (2)' })).toHaveTextContent('Narnia');
    expect(screen.getAllByTestId('marker')).toHaveLength(2);
  });

  test('resolved:true with lat,lng → pin appears, no warning, agent leaves the tray', async () => {
    updateLocationSpy.mockResolvedValue({ data: { id: 2, name: 'Nora Null', location: '-12.0464,-77.0428', resolved: true, lat: -12.0464, lng: -77.0428 } });
    mount();
    const tray = await screen.findByRole('region', { name: 'Location not set / unrecognized (2)' });
    fireEvent.click(within(tray).getByRole('button', { name: 'Edit location for Nora Null' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
    const input = screen.getByRole('textbox', { name: 'Custom location (city name or lat,lng)' });
    fireEvent.change(input, { target: { value: ' -12.0464, -77.0428 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(updateLocationSpy).toHaveBeenCalledWith(2, '-12.0464, -77.0428'));
    await screen.findByRole('region', { name: 'Location not set / unrecognized (1)' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const positions = screen.getAllByTestId('marker').map((m) => m.getAttribute('data-position'));
    expect(positions).toContain('-12.0464,-77.0428');
  });

  test('a 400 from the PATCH surfaces its message instead of window.alert', async () => {
    updateLocationSpy.mockRejectedValue({ response: { data: { message: 'Coordinates must be "lat,lng" with lat in -90..90 and lng in -180..180' } } });
    mount();
    const tray = await screen.findByRole('region', { name: /Location not set/ });
    fireEvent.click(within(tray).getByRole('button', { name: 'Edit location for Nora Null' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
    const input = screen.getByRole('textbox', { name: 'Custom location (city name or lat,lng)' });
    fireEvent.change(input, { target: { value: '95,10' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Editor stays open (value not lost) and the server message shows once it closes.
    await waitFor(() => expect(updateLocationSpy).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: 'Custom location (city name or lat,lng)' })).toHaveValue('95,10');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Coordinates must be "lat,lng"');
  });
});
