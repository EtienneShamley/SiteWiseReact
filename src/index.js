import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './styles/nav.css';
import App from './App';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider } from './context/AuthContext';
import { DataScopeProvider } from './context/DataScopeContext';
import { AppStateProvider } from './context/AppStateContext';
import AuthGate from './components/auth/AuthGate';

// Provider order is the trust order. Identity (AuthProvider) is resolved
// first; AuthGate renders nothing below it until a session is known, so
// the application state provider — which reads this browser's local data
// on mount — exists only for a signed-in user, and signing out unmounts it
// without touching what is stored.
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  //<React.StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <AuthGate>
          <DataScopeProvider>
            <AppStateProvider>
              <App />
            </AppStateProvider>
          </DataScopeProvider>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  //</React.StrictMode>
);

// Service worker remains the same
serviceWorkerRegistration.unregister();
