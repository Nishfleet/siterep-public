import "./styles.css";

window.addEventListener("load", () => {
  requestAnimationFrame(() => {
    setTimeout(() => void import("./mount"), 0);
  });
});
