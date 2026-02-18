import { useState } from 'react';
import axios from 'axios';
import { 
  Send, 
  CheckCircle, 
  XCircle, 
  Loader, 
  AlertCircle, 
  Clock, 
  Mail,
  Code,
  Filter,
  Calculator,
  FileText,
  Play,
  X,
} from 'lucide-react';
import JsonInspector from './JsonInspector';

export default function AutoResponseTestInteractive() {
  const [formData, setFormData] = useState({
    senderEmail: '',
    senderName: '',
    subject: '',
    body: '',
  });
  const [isTesting, setIsTesting] = useState(false);
  const [currentStep, setCurrentStep] = useState('');
  const [dryRunResult, setDryRunResult] = useState(null);
  const [activeStep, setActiveStep] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(0);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
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

  const handleRunDryRun = async () => {
    if (!formData.senderEmail || !formData.subject) {
      return;
    }

    setIsTesting(true);
    setDryRunResult(null);
    setSendResult(null);
    setElapsedTime(0);

    // Start elapsed time counter
    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 100);

    // Simulate step progress (since we don't have real-time updates)
    const stepSimulator = setTimeout(() => setCurrentStep('Loading configuration...'), 500);
    const stepSimulator2 = setTimeout(() => setCurrentStep('Classifying with AI (this may take 10-20 seconds)...'), 1000);
    const stepSimulator3 = setTimeout(() => setCurrentStep('Generating response with AI...'), 15000);
    const stepSimulator4 = setTimeout(() => setCurrentStep('Preparing email preview...'), 30000);

    try {
      const response = await axios.post('/api/autoresponse/test', formData, {
        timeout: 90000, // 90 second timeout for slow LLM calls
      });
      
      console.log('Dry-run response:', response.data);
      
      // Include success flag from parent response
      setDryRunResult({
        success: response.data.success,
        ...response.data.data,
      });
      setActiveStep(0);
      setCurrentStep('');
    } catch (error) {
      console.error('Dry-run error:', error);
      console.error('Error response:', error.response?.data);
      
      setDryRunResult({
        success: false,
        error: error.response?.data?.message || error.response?.data?.error || error.message,
        executionTrace: error.response?.data?.executionTrace || null,
      });
      setCurrentStep('');
    } finally {
      clearInterval(timer);
      clearTimeout(stepSimulator);
      clearTimeout(stepSimulator2);
      clearTimeout(stepSimulator3);
      clearTimeout(stepSimulator4);
      setIsTesting(false);
      setElapsedTime(0);
    }
  };

  const handleSendEmail = async () => {
    if (!dryRunResult?.sendData) return;

    setIsSending(true);
    setSendResult(null);

    try {
      const response = await axios.post('/api/autoresponse/test/send', {
        sendData: dryRunResult.sendData,
      });
      setSendResult(response.data);
    } catch (error) {
      setSendResult({
        success: false,
        error: error.response?.data?.message || error.message,
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleClose = () => {
    setDryRunResult(null);
    setSendResult(null);
    setActiveStep(0);
  };

  const steps = dryRunResult?.executionTrace?.steps || [];
  const etaStep = steps.find((s) => s.step === 4);
  const etaReason = etaStep?.output?.reason || '';
  const etaQueueStats = etaStep?.input?.queueStats || null;
  const etaDetails = etaQueueStats
    ? {
      ticketsArrivedSoFarToday: etaQueueStats.ticketsArrivedSoFarToday,
      recentOpenBacklog: etaQueueStats.recentOpenBacklog,
      activeAgentCount: etaQueueStats.activeAgentCount,
      minutesSinceBusinessStart: etaQueueStats.minutesSinceBusinessStart,
      timezone: etaQueueStats.timezone,
    }
    : null;
  const stepNav = [
    { id: 0, label: 'Config', icon: Code },
    { id: 1, label: 'Filtering', icon: Filter },
    { id: 2, label: 'Classification', icon: FileText },
    { id: 3, label: 'Availability', icon: Clock },
    { id: 4, label: 'ETA', icon: Calculator },
    { id: 5, label: 'Context', icon: FileText },
    { id: 6, label: 'Response', icon: Mail },
    { id: 7, label: 'Email', icon: Send },
  ];

  return (
    <div className="space-y-4">
      {/* Compact Header with Info */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Play className="w-5 h-5 text-blue-700" />
          <div>
            <h2 className="text-sm font-semibold text-blue-900">Test Auto-Response System (Dry Run)</h2>
            <p className="text-xs text-blue-700">Review full LLM workflow • Inspect all prompts & outputs • Send email after review</p>
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
      {!dryRunResult && (
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
              onClick={handleRunDryRun}
              disabled={isTesting || !formData.senderEmail || !formData.subject}
              className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {isTesting ? (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  Running Dry Run...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Run Dry Run Test
                </>
              )}
            </button>
          </div>

          {/* Progress Indicator */}
          {isTesting && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Loader className="w-5 h-5 animate-spin text-blue-600" />
                  <span className="text-sm font-medium text-blue-900">{currentStep || 'Processing...'}</span>
                </div>
                <span className="text-xs text-blue-700 font-mono">{elapsedTime}s elapsed</span>
              </div>
              <div className="text-xs text-blue-700 mt-2">
                ⏱️ LLM calls typically take 20-40 seconds. Please wait...
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dry Run Results - Timeline View with Tabs */}
      {dryRunResult && dryRunResult.success && (
        <div className="flex gap-4 items-start">
          {/* Right Side Nav Tabs - Sticky */}
          <div className="w-48 flex-shrink-0 space-y-1 sticky top-0">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-2">
              <p className="text-xs font-semibold text-gray-700 mb-2 px-2">Quick Jump</p>
              {stepNav.map((nav) => {
                const step = steps.find(s => s.step === nav.id);
                const Icon = nav.icon;
                return (
                  <button
                    key={nav.id}
                    onClick={() => {
                      setActiveStep(nav.id);
                      document.getElementById(`step-${nav.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
                      activeStep === nav.id
                        ? 'bg-blue-100 text-blue-700 font-medium'
                        : 'text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="flex-1 text-left">{nav.label}</span>
                    {step && <CheckCircle className="w-3 h-3 text-green-600" />}
                  </button>
                );
              })}
            </div>

            {/* Summary Card */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
              <p className="text-xs font-semibold text-gray-700 mb-2">Summary</p>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-600">Classification:</span>
                  <span className="font-semibold">{dryRunResult.summary.classification}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Severity:</span>
                  <span className="font-semibold">{dryRunResult.summary.severity}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">ETA:</span>
                  <span className="font-semibold">{dryRunResult.summary.estimatedWaitMinutes} min</span>
                </div>
                {etaReason && (
                  <div className="pt-1">
                    <p className="text-gray-600">ETA details:</p>
                    <p className="text-gray-800 leading-snug">{etaReason}</p>
                    {etaDetails && (
                      <div className="mt-1">
                        <JsonInspector data={etaDetails} />
                      </div>
                    )}
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-600">Config:</span>
                  <span className="font-semibold">v{dryRunResult.summary.configVersion}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Model:</span>
                  <span className="font-semibold">{dryRunResult.summary.model || '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Reasoning:</span>
                  <span className="font-semibold capitalize">{dryRunResult.summary.reasoningEffort || 'none'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Verbosity:</span>
                  <span className="font-semibold capitalize">{dryRunResult.summary.verbosity || 'medium'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Tokens:</span>
                  <span className="font-semibold">{dryRunResult.summary.totalTokens}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Duration:</span>
                  <span className="font-semibold">{dryRunResult.summary.totalDuration}ms</span>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="space-y-2">
              <button
                onClick={handleSendEmail}
                disabled={isSending || !!sendResult}
                className="w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2.5 rounded text-sm font-medium disabled:opacity-50 transition-colors shadow-sm"
              >
                {isSending ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Send Email
                  </>
                )}
              </button>

              <button
                onClick={handleClose}
                className="w-full flex items-center justify-center gap-2 bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
              >
                <X className="w-4 h-4" />
                Close & Clear
              </button>
            </div>

            {/* Send Result */}
            {sendResult && (
              <div className={`p-3 rounded text-xs ${
                sendResult.success ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'
              }`}>
                {sendResult.success ? (
                  <>
                    <CheckCircle className="w-4 h-4 inline mr-1" />
                    Email sent successfully!
                  </>
                ) : (
                  <>
                    <XCircle className="w-4 h-4 inline mr-1" />
                    {sendResult.error}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Left Side Timeline */}
          <div className="flex-1 space-y-3">
            {/* Step Cards */}
            {steps.map((step, _idx) => (
              <div
                key={step.step}
                id={`step-${step.step}`}
                className={`bg-white border rounded-lg overflow-hidden transition-all ${
                  activeStep === step.step ? 'border-blue-400 shadow-md' : 'border-gray-200'
                }`}
              >
                {/* Step Header */}
                <div className={`px-4 py-2.5 flex items-center justify-between ${
                  activeStep === step.step ? 'bg-blue-50' : 'bg-gray-50'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      activeStep === step.step ? 'bg-blue-600 text-white' : 'bg-gray-300 text-gray-700'
                    }`}>
                      {step.step}
                    </span>
                    <h3 className="text-sm font-semibold text-gray-900">{step.name}</h3>
                  </div>
                  <span className="text-xs text-gray-500">{step.duration}ms</span>
                </div>

                {/* Step Content */}
                <div className="p-4 space-y-3">
                  {/* Input */}
                  {step.input && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-2">Input:</p>
                      <JsonInspector data={step.input} highlightKeys={['prompt', 'model']} />
                    </div>
                  )}

                  {/* Output */}
                  {step.output && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-2">Output:</p>
                      <JsonInspector 
                        data={step.output} 
                        highlightKeys={[
                          'classification', 
                          'sourceType', 
                          'severity', 
                          'category',
                          'estimatedMinutes',
                          'response',
                          'finalSubject',
                          'finalBody',
                        ]} 
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Final Email Preview */}
            {dryRunResult?.email && (
              <div
                id="step-email-preview"
                className="bg-white border border-gray-200 rounded-lg overflow-hidden"
              >
                <div className="px-4 py-2.5 bg-green-50 border-b border-green-200">
                  <h3 className="text-sm font-semibold text-green-900 flex items-center gap-2">
                    <Mail className="w-4 h-4" />
                    Final Email Preview
                  </h3>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-gray-700 mb-1">To:</p>
                    <p className="text-sm text-gray-900">{dryRunResult.email.to}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-700 mb-1">Subject:</p>
                    <p className="text-sm text-gray-900">{dryRunResult.email.subject}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-700 mb-1">Body:</p>
                    <div className="bg-gray-50 border border-gray-200 rounded p-3">
                      <pre className="text-sm text-gray-800 whitespace-pre-wrap font-sans">{dryRunResult.email.body}</pre>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error Display */}
      {dryRunResult && !dryRunResult.success && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
            <div>
              <p className="font-semibold text-sm text-red-900">Dry-run failed</p>
              <p className="text-xs text-red-700 mt-1">{dryRunResult.error}</p>
              <button
                onClick={handleClose}
                className="mt-3 text-xs text-red-600 hover:text-red-700 font-medium"
              >
                Close & Try Again
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

