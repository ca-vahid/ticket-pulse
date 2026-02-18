import { useState } from 'react';
import axios from 'axios';
import { Send, CheckCircle, XCircle, Loader, AlertCircle, Clock, Mail } from 'lucide-react';

export default function AutoResponseTest() {
  const [formData, setFormData] = useState({
    senderEmail: '',
    senderName: '',
    subject: '',
    body: '',
  });
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleTest = async () => {
    if (!formData.senderEmail || !formData.subject) {
      setTestResult({
        success: false,
        message: 'Please fill in at least the email and subject fields',
      });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const response = await axios.post('/api/autoresponse/test', formData);

      setTestResult({
        success: true,
        message: 'Auto-response test completed successfully!',
        data: response.data.data,
      });
    } catch (error) {
      setTestResult({
        success: false,
        message: error.response?.data?.message || error.message || 'Test failed',
        error: error.response?.data?.error,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleQuickFill = () => {
    const names = ['Sarah Chen', 'Michael Rodriguez', 'Emily Thompson', 'David Park', 'Jessica Martinez'];
    const randomName = names[Math.floor(Math.random() * names.length)];
    
    setFormData({
      senderEmail: 'vhaeri@bgcengineering.ca',
      senderName: randomName,
      subject: 'I need help with my password',
      body: 'Hi, I forgot my password and cannot log into my account. Can you please help me reset it? Thanks!',
    });
  };

  return (
    <div className="space-y-4">
      {/* Compact Header with Info */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Send className="w-5 h-5 text-blue-700" />
          <div>
            <h2 className="text-sm font-semibold text-blue-900">Test Auto-Response System</h2>
            <p className="text-xs text-blue-700">Uses exact workflow as real tickets • AI classification • ETA calculation • Actual email delivery</p>
          </div>
        </div>
        <button
          onClick={handleQuickFill}
          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-xs font-medium transition-colors shadow-sm"
        >
          <AlertCircle className="w-3.5 h-3.5" />
          Use Sample Data
        </button>
      </div>

      {/* Form */}
      <div className="bg-white rounded-lg shadow-sm p-4 border border-gray-200 space-y-4">
        {/* Single Row for Email, Name, Subject */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              Sender Email <span className="text-red-500">*</span>
            </label>
            <input
              type="email"
              name="senderEmail"
              value={formData.senderEmail}
              onChange={handleChange}
              placeholder="user@example.com"
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              Sender Name
            </label>
            <input
              type="text"
              name="senderName"
              value={formData.senderName}
              onChange={handleChange}
              placeholder="John Doe"
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              Subject <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="subject"
              value={formData.subject}
              onChange={handleChange}
              placeholder="I need help with..."
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Email Body - Full Width, Larger */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1.5">
            Email Body
          </label>
          <textarea
            name="body"
            value={formData.body}
            onChange={handleChange}
            placeholder="Describe the issue in detail..."
            rows={20}
            className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Test Button */}
        <div className="flex justify-end">
          <button
            onClick={handleTest}
            disabled={isTesting || !formData.senderEmail || !formData.subject}
            className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            {isTesting ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                Processing Test...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Run Auto-Response Test
              </>
            )}
          </button>
        </div>
      </div>

      {/* Result Display */}
      {testResult && (
        <div className={`rounded-lg p-4 ${testResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
          <div className="flex items-start gap-3">
            {testResult.success ? (
              <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
            ) : (
              <XCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
            )}
            <div className="flex-1">
              <p className={`font-semibold text-sm ${testResult.success ? 'text-green-900' : 'text-red-900'}`}>
                {testResult.message}
              </p>

              {testResult.success && testResult.data && (
                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-4 gap-2">
                    <div className="bg-white rounded p-2.5 border border-green-100">
                      <p className="text-xs text-gray-600 uppercase font-medium">Classification</p>
                      <p className="font-semibold text-sm text-gray-900 mt-1">{testResult.data.classification}</p>
                    </div>
                    <div className="bg-white rounded p-2.5 border border-green-100">
                      <p className="text-xs text-gray-600 uppercase font-medium">Severity</p>
                      <p className="font-semibold text-sm text-gray-900 mt-1">{testResult.data.severity || 'N/A'}</p>
                    </div>
                    <div className="bg-white rounded p-2.5 border border-green-100">
                      <p className="text-xs text-gray-600 uppercase font-medium flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        ETA
                      </p>
                      <p className="font-semibold text-sm text-gray-900 mt-1">{testResult.data.estimatedWaitMinutes} min</p>
                    </div>
                    <div className="bg-white rounded p-2.5 border border-green-100">
                      <p className="text-xs text-gray-600 uppercase font-medium flex items-center gap-1">
                        <Mail className="w-3 h-3" />
                        Sent
                      </p>
                      <p className="font-semibold text-sm text-gray-900 mt-1">{testResult.data.responseSent ? '✓ Yes' : '✗ No'}</p>
                    </div>
                  </div>

                  {(testResult.data.isAfterHours || testResult.data.isHoliday) && (
                    <div className="flex gap-2">
                      {testResult.data.isAfterHours && (
                        <div className="flex-1 bg-yellow-50 border border-yellow-200 rounded p-2 text-xs text-yellow-800">
                          ⏰ After-hours request
                        </div>
                      )}
                      {testResult.data.isHoliday && (
                        <div className="flex-1 bg-purple-50 border border-purple-200 rounded p-2 text-xs text-purple-800">
                          🎉 Holiday
                        </div>
                      )}
                    </div>
                  )}

                  <div className="text-xs text-gray-600 pt-2 border-t border-green-200">
                    ID: {testResult.data.autoResponseId} • {testResult.data.duration}ms
                  </div>

                  {testResult.data.responseSent && (
                    <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-800">
                      <Mail className="w-4 h-4 inline mr-1.5" />
                      Check inbox at <strong>{formData.senderEmail}</strong> for the auto-response email
                    </div>
                  )}
                </div>
              )}

              {!testResult.success && testResult.error && (
                <div className="mt-2">
                  <p className="font-medium text-xs text-red-900">Error Details:</p>
                  <pre className="mt-1 bg-red-100 rounded p-2 text-xs overflow-x-auto font-mono">{testResult.error}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

