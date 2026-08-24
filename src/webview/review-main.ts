import ReviewApp from './ReviewApp.svelte';
import './styles/global.css';

const app = new ReviewApp({
  target: document.getElementById('app')!,
});

export default app;
