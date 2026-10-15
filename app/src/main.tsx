import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installDesktopShell } from './desktop';
import './styles.css';

// Before React mounts, so the very first right-click / F5 is already handled.
installDesktopShell();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
