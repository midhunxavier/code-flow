const copy = document.querySelector('#copy-command');
copy?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector('#install-command').textContent);
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  } catch {
    copy.textContent = 'Select to copy';
  }
});
