import { useState, useEffect } from 'react';
import { X, Save, RotateCcw, Copy, Check, Info } from 'lucide-react';

export default function PromptEditorModal({ isOpen, onClose, title, value, onChange, placeholders, defaultValue }) {
  const [localValue, setLocalValue] = useState(value);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  if (!isOpen) return null;

  const handleSave = () => {
    onChange(localValue);
    onClose();
  };

  const handleReset = () => {
    if (confirm('Reset to default prompt? This will discard your changes.')) {
      setLocalValue(defaultValue);
    }
  };

  const handleCopyPlaceholder = (placeholder) => {
    navigator.clipboard.writeText(placeholder);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Categorize placeholders for better organization
  const categorizePlaceholders = (placeholderList) => {
    const emailFields = ['senderName', 'senderEmail', 'subject', 'body'];
    const systemFields = ['context', 'instructions'];
    
    const categories = {
      email: [],
      classification: [],
      system: [],
    };
    
    placeholderList.forEach(p => {
      if (emailFields.includes(p)) {
        categories.email.push(p);
      } else if (systemFields.includes(p)) {
        categories.system.push(p);
      } else {
        categories.classification.push(p);
      }
    });
    
    return categories;
  };

  const categorized = categorizePlaceholders(placeholders);
  const isResponsePrompt = categorized.classification.length > 0;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fadeIn">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden animate-scaleIn">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-shrink-0 bg-white">
          <div>
            <h3 className="text-lg font-bold text-gray-900">{title}</h3>
            <p className="text-xs text-gray-500 mt-0.5">Edit the system prompt used by the LLM</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Default
            </button>
            <div className="h-6 w-px bg-gray-200"></div>
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Editor Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Text Editor */}
          <div className="flex-1 flex flex-col relative">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-b from-gray-50 to-transparent z-10 pointer-events-none"></div>
            <textarea
              value={localValue}
              onChange={(e) => setLocalValue(e.target.value)}
              className="flex-1 px-6 py-6 font-mono text-sm leading-relaxed text-gray-800 border-0 focus:outline-none focus:ring-0 resize-none bg-white"
              placeholder="Enter your prompt here..."
              spellCheck="false"
            />
            <div className="px-6 py-2 bg-gray-50 border-t border-gray-200 flex items-center justify-between text-xs text-gray-500">
              <span>{localValue.length} characters</span>
              <span>Markdown supported</span>
            </div>
          </div>

          {/* Right: Placeholders & Help */}
          <div className="w-80 flex flex-col bg-gray-50 border-l border-gray-200">
            <div className="px-5 py-4 border-b border-gray-200 bg-gray-50">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <Info className="w-4 h-4 text-blue-500" />
                Available Variables
              </h4>
              <p className="text-xs text-gray-500 mt-1">Click to copy and paste into editor</p>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
              {!isResponsePrompt ? (
                // Simple list for classification prompt
                <div className="space-y-2">
                  {placeholders.map(placeholder => (
                    <button
                      key={placeholder}
                      onClick={() => handleCopyPlaceholder(`{{${placeholder}}}`)}
                      className="w-full flex items-center justify-between px-3 py-2.5 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm hover:bg-blue-50/50 transition-all group text-left"
                    >
                      <code className="text-xs font-mono text-blue-700 font-medium">{`{{${placeholder}}}`}</code>
                      {copied ? (
                        <Check className="w-3.5 h-3.5 text-green-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-500" />
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                // Categorized list for response prompt
                <>
                  {categorized.email.length > 0 && (
                    <div>
                      <h5 className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wider">Email Metadata</h5>
                      <div className="space-y-1.5">
                        {categorized.email.map(placeholder => (
                          <button
                            key={placeholder}
                            onClick={() => handleCopyPlaceholder(`{{${placeholder}}}`)}
                            className="w-full flex items-center justify-between px-3 py-2 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm hover:bg-blue-50/50 transition-all group text-left"
                          >
                            <code className="text-xs font-mono text-blue-700 font-medium">{`{{${placeholder}}}`}</code>
                            {copied ? (
                              <Check className="w-3.5 h-3.5 text-green-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-500" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {categorized.classification.length > 0 && (
                    <div>
                      <h5 className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wider flex items-center gap-1.5">
                        Classification Output
                        <span className="text-green-600 bg-green-50 px-1.5 py-0.5 rounded text-[10px] font-bold">
                          {categorized.classification.length} fields
                        </span>
                      </h5>
                      <div className="space-y-1.5">
                        {categorized.classification.map(placeholder => (
                          <button
                            key={placeholder}
                            onClick={() => handleCopyPlaceholder(`{{${placeholder}}}`)}
                            className="w-full flex items-center justify-between px-3 py-2 bg-white border border-green-200 rounded-lg hover:border-green-400 hover:shadow-sm hover:bg-green-50/50 transition-all group text-left"
                          >
                            <code className="text-xs font-mono text-green-700 font-medium">{`{{${placeholder}}}`}</code>
                            {copied ? (
                              <Check className="w-3.5 h-3.5 text-green-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5 text-gray-300 group-hover:text-green-600" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {categorized.system.length > 0 && (
                    <div>
                      <h5 className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wider">System Context</h5>
                      <div className="space-y-1.5">
                        {categorized.system.map(placeholder => (
                          <button
                            key={placeholder}
                            onClick={() => handleCopyPlaceholder(`{{${placeholder}}}`)}
                            className="w-full flex items-center justify-between px-3 py-2 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm hover:bg-blue-50/50 transition-all group text-left"
                          >
                            <code className="text-xs font-mono text-blue-700 font-medium">{`{{${placeholder}}}`}</code>
                            {copied ? (
                              <Check className="w-3.5 h-3.5 text-green-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-500" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              
              <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl">
                <h5 className="text-xs font-bold text-blue-800 mb-1 flex items-center gap-1.5">
                  <span className="text-lg">💡</span> Pro Tip
                </h5>
                <p className="text-xs text-blue-700 leading-relaxed">
                  {isResponsePrompt 
                    ? 'Classification fields are auto-detected from your Classification Prompt. Any JSON field you define there becomes available here.'
                    : 'Be specific with your instructions. The model works best when you provide clear examples and constraints.'
                  }
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium text-sm transition-all shadow-sm hover:shadow"
          >
            <Save className="w-4 h-4" />
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
