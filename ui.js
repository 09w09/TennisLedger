(() => {
  "use strict";

  const DOGS = [
    { src: "./assets/dogs/dog-01-golden-retriever.png", scale: 0.9892 },
    { src: "./assets/dogs/dog-02-dachshund.png", scale: 1.0311 },
    { src: "./assets/dogs/dog-03-corgi.png", scale: 0.8838 },
    { src: "./assets/dogs/dog-04-poodle.png", scale: 0.8508 },
    { src: "./assets/dogs/dog-05-dalmatian.png", scale: 1.0111 },
    { src: "./assets/dogs/dog-06-beagle.png", scale: 1.0994 },
    { src: "./assets/dogs/dog-07-french-bulldog.png", scale: 0.9171 },
    { src: "./assets/dogs/dog-08-german-shepherd.png", scale: 0.8314 },
    { src: "./assets/dogs/dog-09-border-collie.png", scale: 1.2007 },
    { src: "./assets/dogs/dog-10-shiba-inu.png", scale: 1.2807 },
    { src: "./assets/dogs/dog-11-husky-a.png", scale: 1.3774 },
    { src: "./assets/dogs/dog-12-husky-b.png", scale: 0.9733 }
  ];

  const dog = document.getElementById("ledger-dog");
  const detailView = document.getElementById("ledger-detail-view");
  const ledgerTitle = document.getElementById("ledger-title");

  if (!dog || !detailView || !ledgerTitle) return;

  let wasVisible = false;
  let lastIndex = -1;

  function randomIndex() {
    let index;

    if (window.crypto?.getRandomValues) {
      const value = new Uint32Array(1);
      window.crypto.getRandomValues(value);
      index = value[0] % DOGS.length;
    } else {
      index = Math.floor(Math.random() * DOGS.length);
    }

    if (DOGS.length > 1 && index === lastIndex) {
      index = (index + 1) % DOGS.length;
    }

    return index;
  }

  function syncDog() {
    const title = ledgerTitle.textContent.trim();
    const visible =
      !detailView.classList.contains("hidden") &&
      title &&
      title !== "—";

    dog.hidden = !visible;

    if (!visible) {
      wasVisible = false;
      return;
    }

    if (!wasVisible) {
      const index = randomIndex();
      dog.src = DOGS[index].src;
      dog.style.setProperty("--dog-scale", String(DOGS[index].scale));
      lastIndex = index;
    }

    wasVisible = true;
  }

  const observer = new MutationObserver(syncDog);

  observer.observe(detailView, {
    attributes: true,
    attributeFilter: ["class"]
  });

  observer.observe(ledgerTitle, {
    childList: true,
    subtree: true,
    characterData: true
  });

  const adminMenu = document.querySelector(".admin-menu");
  const adminMenuSummary = adminMenu?.querySelector("summary");

  function closeAdminMenu({ restoreFocus = false } = {}) {
    const wasOpen = adminMenu?.hasAttribute("open") ?? false;
    adminMenu?.removeAttribute("open");
    if (restoreFocus && wasOpen) adminMenuSummary?.focus();
  }

  adminMenu?.addEventListener("click", (event) => {
    if (event.target.closest(".menu-action")) closeAdminMenu();
  });

  document.addEventListener("click", (event) => {
    if (adminMenu?.hasAttribute("open") && !adminMenu.contains(event.target)) {
      closeAdminMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && adminMenu?.hasAttribute("open")) {
      event.preventDefault();
      closeAdminMenu({ restoreFocus: true });
    }
  });

  syncDog();
})();
