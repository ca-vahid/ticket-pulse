import { useState, useEffect } from 'react';
import axios from 'axios';
import { Clock, Plus, Trash2, CheckCircle, XCircle, Calendar, Globe } from 'lucide-react';

export default function AutoResponseSettings() {
  const [businessHours, setBusinessHours] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState(null);
  const [availability, setAvailability] = useState(null);

  const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [hoursRes, holidaysRes, availRes] = await Promise.all([
        axios.get('/api/autoresponse/business-hours'),
        axios.get('/api/autoresponse/holidays'),
        axios.get('/api/autoresponse/availability/check'),
      ]);

      setBusinessHours(hoursRes.data.data || []);
      setHolidays(holidaysRes.data.data || []);
      setAvailability(availRes.data.data || null);
    } catch (error) {
      console.error('Failed to fetch auto-response settings:', error);
      setSaveStatus({ success: false, message: 'Failed to load settings' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleBusinessHoursChange = (index, field, value) => {
    const updated = [...businessHours];
    updated[index] = { ...updated[index], [field]: value };
    setBusinessHours(updated);
  };

  const handleAddBusinessHour = () => {
    setBusinessHours([
      ...businessHours,
      {
        dayOfWeek: 1,
        startTime: '09:00',
        endTime: '17:00',
        isEnabled: true,
        timezone: 'America/Los_Angeles',
      },
    ]);
  };

  const handleRemoveBusinessHour = (index) => {
    setBusinessHours(businessHours.filter((_, i) => i !== index));
  };

  const handleSaveBusinessHours = async () => {
    try {
      await axios.put('/api/autoresponse/business-hours', { hours: businessHours });
      setSaveStatus({ success: true, message: 'Business hours saved successfully!' });
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (error) {
      setSaveStatus({ success: false, message: 'Failed to save business hours' });
    }
  };

  const handleAddHoliday = async () => {
    const name = prompt('Holiday name:');
    const date = prompt('Date (YYYY-MM-DD):');
    
    if (!name || !date) return;

    try {
      await axios.post('/api/autoresponse/holidays', {
        name,
        date,
        isRecurring: false,
        country: null,
      });
      setSaveStatus({ success: true, message: 'Holiday added!' });
      fetchData();
    } catch (error) {
      setSaveStatus({ success: false, message: 'Failed to add holiday' });
    }
  };

  const handleDeleteHoliday = async (id) => {
    if (!confirm('Delete this holiday?')) return;

    try {
      await axios.delete(`/api/autoresponse/holidays/${id}`);
      setSaveStatus({ success: true, message: 'Holiday deleted!' });
      fetchData();
    } catch (error) {
      setSaveStatus({ success: false, message: 'Failed to delete holiday' });
    }
  };

  const handleLoadCanadianHolidays = async () => {
    const year = new Date().getFullYear();
    if (!confirm(`Load Canadian holidays for ${year}?`)) return;

    try {
      await axios.post('/api/autoresponse/holidays/load-canadian', { year });
      setSaveStatus({ success: true, message: `Canadian holidays loaded for ${year}!` });
      fetchData();
    } catch (error) {
      setSaveStatus({ success: false, message: 'Failed to load holidays' });
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
        <p className="text-gray-600">Loading auto-response settings...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status Banner */}
      {availability && (
        <div className={`p-4 rounded-lg ${availability.isBusinessHours ? 'bg-green-50' : 'bg-yellow-50'}`}>
          <div className="flex items-center gap-2">
            {availability.isBusinessHours ? (
              <CheckCircle className="w-5 h-5 text-green-600" />
            ) : (
              <XCircle className="w-5 h-5 text-yellow-600" />
            )}
            <div>
              <p className={`font-semibold ${availability.isBusinessHours ? 'text-green-800' : 'text-yellow-800'}`}>
                {availability.isBusinessHours ? 'Currently In Business Hours' : 'Currently Outside Business Hours'}
              </p>
              <p className="text-sm text-gray-700">{availability.reason}</p>
              {availability.isHoliday && (
                <p className="text-sm text-gray-700">Holiday: {availability.holidayName}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Business Hours Section */}
      <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Clock className="w-5 h-5" />
            Business Hours
          </h2>
          <button
            onClick={handleAddBusinessHour}
            className="flex items-center gap-1 text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded"
          >
            <Plus className="w-4 h-4" />
            Add Hours
          </button>
        </div>

        <div className="space-y-3">
          {businessHours.length === 0 ? (
            <p className="text-gray-500 text-sm">No business hours configured. Add hours to enable auto-responses.</p>
          ) : (
            businessHours.map((hour, index) => (
              <div key={index} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <select
                  value={hour.dayOfWeek}
                  onChange={(e) => handleBusinessHoursChange(index, 'dayOfWeek', parseInt(e.target.value))}
                  className="px-3 py-2 border border-gray-300 rounded text-sm"
                >
                  {daysOfWeek.map((day, i) => (
                    <option key={i} value={i}>{day}</option>
                  ))}
                </select>

                <input
                  type="time"
                  value={hour.startTime}
                  onChange={(e) => handleBusinessHoursChange(index, 'startTime', e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded text-sm"
                />

                <span className="text-gray-500">to</span>

                <input
                  type="time"
                  value={hour.endTime}
                  onChange={(e) => handleBusinessHoursChange(index, 'endTime', e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded text-sm"
                />

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={hour.isEnabled}
                    onChange={(e) => handleBusinessHoursChange(index, 'isEnabled', e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm">Enabled</span>
                </label>

                <button
                  onClick={() => handleRemoveBusinessHour(index)}
                  className="ml-auto text-red-600 hover:text-red-700 p-1"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>

        <button
          onClick={handleSaveBusinessHours}
          className="mt-4 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm"
        >
          Save Business Hours
        </button>
      </div>

      {/* Holidays Section */}
      <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Calendar className="w-5 h-5" />
            Holidays
          </h2>
          <div className="flex gap-2">
            <button
              onClick={handleLoadCanadianHolidays}
              className="flex items-center gap-1 text-sm bg-purple-600 hover:bg-purple-700 text-white px-3 py-1 rounded"
            >
              <Globe className="w-4 h-4" />
              Load Canadian
            </button>
            <button
              onClick={handleAddHoliday}
              className="flex items-center gap-1 text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded"
            >
              <Plus className="w-4 h-4" />
              Add Holiday
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {holidays.length === 0 ? (
            <p className="text-gray-500 text-sm">No holidays configured.</p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {holidays.map((holiday) => (
                <div key={holiday.id} className="flex items-center justify-between p-2 hover:bg-gray-50 rounded">
                  <div className="flex-1">
                    <p className="font-medium text-sm">{holiday.name}</p>
                    <p className="text-xs text-gray-500">
                      {new Date(holiday.date).toLocaleDateString()}
                      {holiday.isRecurring && ' (Recurring)'}
                      {holiday.country && ` - ${holiday.country}`}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDeleteHoliday(holiday.id)}
                    className="text-red-600 hover:text-red-700 p-1"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Status Messages */}
      {saveStatus && (
        <div className={`flex items-center gap-2 p-4 rounded-lg ${saveStatus.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
          {saveStatus.success ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
          <span>{saveStatus.message}</span>
        </div>
      )}
    </div>
  );
}

