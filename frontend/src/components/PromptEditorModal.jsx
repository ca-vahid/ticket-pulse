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
      <div className="bg-card rounded-xl shadow-2xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden animate-scaleIn">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-shrink-0 bg-card">
          <div>
            <h3 className="text-lg font-bold text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Edit the system prompt used by the LLM</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg border border-border hover:bg-muted/50 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Default
            </button>
            <div className="h-6 w-px bg-secondary"></div>
            <button
              onClick={onClose}
              className="p-2 text-muted-foreground/75 hover:text-muted-foreground rounded-lg hover:bg-muted transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Editor Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Text Editor */}
          <div className="flex-1 flex flex-col relative">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-b from-muted/50 to-transparent z-10 pointer-events-none"></div>
            <textarea
              value={localValue}
              onChange={(e) => setLocalValue(e.target.value)}
              className="flex-1 px-6 py-6 font-mono text-sm leading-relaxed text-foreground border-0 focus:outline-none focus:ring-0 resize-none bg-card"
              placeholder="Enter your prompt here..."
              spellCheck="false"
            />
            <div className="px-6 py-2 bg-muted/50 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
              <span>{localValue.length} characters</span>
              <span>Markdown supported</span>
            </div>
          </div>

          {/* Right: Placeholders & Help */}
          <div className="w-80 flex flex-col bg-muted/50 border-l border-border">
            <div className="px-5 py-4 border-b border-border bg-muted/50">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Info className="w-4 h-4 text-blue-500" />
                Available Variables
              </h4>
              <p className="text-xs text-muted-foreground mt-1">Click to copy and paste into editor</p>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
              {!isResponsePrompt ? (
                // Simple list for classification prompt
                <div className="space-y-2">
                  {placeholders.map(placeholder => (
                    <button
                      key={placeholder}
                      onClick={() => handleCopyPlaceholder(`{{${placeholder}}}`)}
                      className="w-full flex items-center justify-between px-3 py-2.5 bg-card border border-border rounded-lg hover:border-blue-400 hover:shadow-sm hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-all group text-left"
                    >
                      <code className="text-xs font-mono text-blue-700 dark:text-blue-200 font-medium">{`{{${placeholder}}}`}</code>
                      {copied ? (
                        <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-300" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 text-muted-foreground/50 group-hover:text-blue-500" />
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                // Categorized list for response prompt
                <>
                  {categorized.email.length > 0 && (
                    <div>
                      <h5 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Email Metadata</h5>
                      <div className="space-y-1.5">
                        {categorized.email.map(placeholder => (
                          <button
                            key={placeholder}
                            onClick={() => handleCopyPlaceholder(`{{${placeholder}}}`)}
                            className="w-full flex items-center justify-between px-3 py-2 bg-card border border-border rounded-lg hover:border-blue-400 hover:shadow-sm hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-all group text-left"
                          >
                            <code className="text-xs font-mono text-blue-700 dark:text-blue-200 font-medium">{`{{${placeholder}}}`}</code>
                            {copied ? (
                              <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-300" />
                            ) : (
                              <Copy className="w-3.5 h-3.5 text-muted-foreground/50 group-hover:text-blue-500" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {categorized.classification.length > 0 && (
                    <div>
                      <h5 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider flex items-center gap-1.5">
                        Classification Output
                        <span className="text-green-600 dark:text-green-300 bg-green-50 dark:bg-green-500/15 px-1.5 py-0.5 rounded text-[10px] font-bold">
                          {categorized.classification.length} fields
                        </span>
                      </h5>
                      <div className="space-y-1.5">
                        {categorized.classification.map(placeholder => (
                          <button
                            key={placeholder}
                            onClick={() => handleCopyPlaceholder(`{{${placeholder}}}`)}
                            className="w-full flex items-center justify-between px-3 py-2 bg-card border border-green-200 dark:border-green-500/30 rounded-lg hover:border-green-400 hover:shadow-sm hover:bg-green-50/50 dark:hover:bg-green-500/10 transition-all group text-left"
                          >
                            <code className="text-xs font-mono text-green-700 dark:text-green-200 font-medium">{`{{${placeholder}}}`}</code>
                            {copied ? (
                              <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-300" />
                            ) : (
                              <Copy className="w-3.5 h-3.5 text-muted-foreground/50 group-hover:text-green-600 dark:group-hover:text-green-300" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {categorized.system.length > 0 && (
                    <div>
                      <h5 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">System Context</h5>
                      <div className="space-y-1.5">
                        {categorized.system.map(placeholder => (
                          <button
                            key={placeholder}
                            onClick={() => handleCopyPlaceholder(`{{${placeholder}}}`)}
                            className="w-full flex items-center justify-between px-3 py-2 bg-card border border-border rounded-lg hover:border-blue-400 hover:shadow-sm hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-all group text-left"
                          >
                            <code className="text-xs font-mono text-blue-700 dark:text-blue-200 font-medium">{`{{${placeholder}}}`}</code>
                            {copied ? (
                              <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-300" />
                            ) : (
                              <Copy className="w-3.5 h-3.5 text-muted-foreground/50 group-hover:text-blue-500" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              
              <div className="p-4 bg-blue-50 dark:bg-blue-500/15 border border-blue-100 dark:border-blue-500/20 rounded-xl">
                <h5 className="text-xs font-bold text-blue-800 dark:text-blue-200 mb-1 flex items-center gap-1.5">
                  <span className="text-lg">💡</span> Pro Tip
                </h5>
                <p className="text-xs text-blue-700 dark:text-blue-200 leading-relaxed">
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
        <div className="px-6 py-4 border-t border-border flex items-center justify-end gap-3 bg-muted/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-foreground/85 hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
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
