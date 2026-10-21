export function christopherShell(page, consolePage) {
  const sidebar = consolePage.match(/<aside class="ops-sidebar"[\s\S]*?<\/aside>/)?.[0];
  if (!sidebar) throw Error('The shared Colossus navigation is unavailable.');
  const shared = sidebar.replaceAll('href="#', 'href="/app#').replace(/ class="active"/g, '').replace(/ aria-current="page"/g, '')
    .replace('</nav>', '<a href="/admin/christopher" class="active" aria-current="page" id="christopher-private-link"><span>◈</span><span>Christopher</span></a></nav>')
    .replace('Checking configuration', 'Private administrator view').replace('Verifying account', 'Astra administrator').replace('Verifying access', 'Signed-in administrator');
  return page.replace('<!--COLOSSUS_SIDEBAR-->', shared);
}
