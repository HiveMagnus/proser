// Enhanced function to interpolate variables in prompt templates
// Handles multiple patterns: {var}, {var || 'default'}, {varA || varB}, {condition ? `template ${var}` : 'fallback'}
export function interpolatePrompt(template: string, variables: Record<string, unknown>): string {
  if (!template) return '';
  
  let result = template;
  
  // Handle JavaScript-style expressions like {title || 'default'} FIRST
  result = result.replace(/\{([^}]+)\s*\|\|\s*'([^']+)'\}/g, (match, varName, defaultValue) => {
    const value = variables[varName.trim()];
    const replacement = value || defaultValue;
    return String(replacement);
  });

  // Handle variable-to-variable OR like {sceneContext || content}
  result = result.replace(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\|\|\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g, (_match, a, b) => {
    const va = variables[String(a).trim()];
    const vb = variables[String(b).trim()];
    const pick = (va !== undefined && va !== '' && va !== false) ? va : ((vb !== undefined && vb !== '' && vb !== false) ? vb : '');
    return String(pick ?? '');
  });

  // Handle conditional expressions like {condition ? 'text' : ''} or {condition ? `template ${variable}` : ''} SECOND
  result = result.replace(/\{([^}]+?)\s*\?\s*`([^`]+)`\s*:\s*'([^']*)'\}/g, (match, condition, truthyText, falsy) => {
    try {
      // Simple condition evaluation - check if the variable exists and is truthy
      const varName = condition.trim();
      const value = variables[varName];
      
      if (value) {
        // Replace variables within the truthy text
        truthyText = truthyText.replace(/\$\{([^}]+)\}/g, (varMatch: string, varName: string) => {
          const varValue = variables[varName.trim()] || '';
          return String(varValue);
        });
        
        return truthyText;
      } else {
        return falsy;
      }
    } catch {
      return falsy;
    }
  });
  
  // Replace simple template variables like {variable} LAST
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    const replacement = value ?? '';
    result = result.replace(regex, String(replacement));
  }

  // Final cleanup: strip only simple unreplaced tokens like {variable}
  result = result.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, '');
  
  return result.trim();
}
