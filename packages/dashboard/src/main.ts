import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { startDashboardFeedback } from './lib/self-feedback';
import router from './router';
import './style.css';

const app = createApp(App);

app.use(createPinia());
app.use(router);

app.mount('#app');
const stopFeedback = startDashboardFeedback();
if (import.meta.hot) import.meta.hot.dispose(stopFeedback);
