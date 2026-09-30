(() => {
  let ready = false;
  let timer;

  function showStartupFailure() {
    if (ready) return;
    const status = document.querySelector("#wall-status");
    if (status) status.textContent = "Não foi possível iniciar o mural. Atualize a página; se continuar, avise a moderação.";
  }

  timer = setTimeout(showStartupFailure, 8_000);
  window.MONARCHY_WALL_BOOTSTRAP = Object.freeze({
    markReady() {
      ready = true;
      clearTimeout(timer);
    }
  });
  window.addEventListener("error", showStartupFailure);
  window.addEventListener("unhandledrejection", showStartupFailure);
})();
