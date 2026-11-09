import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import Reader from '/src/pages/reader/component.tsx';
import { ConfigService } from '/src/assets/lib/kookit-extra-browser.min';
import { useAppStore } from '/src/store/useAppStore.ts';
import { getPageWidth } from '/src/utils/common.ts';
import { changeLanguage } from '/src/i18n.tsx';
import '/src/assets/styles/reset.css';
import '/src/assets/styles/global.css';
import '/src/assets/styles/style.css';

export async function run() {
  await changeLanguage('zhCN');
  const assert = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const wait = async (check: () => boolean, message: string) => {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error(message);
  };
  ConfigService.setReaderConfig('readerMode', 'scroll');
  ConfigService.setReaderConfig('isOpenInMain', 'yes');
  ConfigService.setReaderConfig('isDisableAI', 'yes');
  ConfigService.setReaderConfig('backgroundColor', '#f5f0e6');
  ConfigService.setReaderConfig('textColor', '#302d29');
  const book = await window.electronAPI.invoke('reader-toolbar-book');
  useAppStore.setState(state => ({
    manager: { ...state.manager, books: [book], plugins: [], notes: [], bookmarks: [] },
    book: { ...state.book, currentBook: book },
    reader: { ...state.reader, readerMode: 'scroll', scale: '1', margin: '40', backgroundColor: '#f5f0e6' },
    handleFetchBooks: () => {}, handleFetchAuthed: () => {}, handleFetchPlugins: () => {},
  }));
  const root = createRoot(document.getElementById('root')!);
  flushSync(() => root.render(<MemoryRouter><Reader /></MemoryRouter>));
  const toolbar = document.querySelector<HTMLElement>('.reader-side-toolbar')!;
  const workspace = document.querySelector<HTMLElement>('.reader-workspace')!;
  const buttons = toolbar.querySelectorAll<HTMLButtonElement>('button');
  let cases = 0;
  assert(buttons.length === 3 && buttons[1].disabled, 'Toolbar scope or pending annotation entry changed');
  assert(buttons[0].getAttribute('aria-label') === '目录' && buttons[2].getAttribute('aria-label') === '阅读设置', 'Chinese accessible labels missing');
  assert(toolbar.parentElement === workspace.parentElement && getComputedStyle(toolbar.parentElement!).display === 'flex', 'Toolbar is not a sibling flex column');
  assert(Math.abs(toolbar.getBoundingClientRect().width - 52) < 1 && Math.abs(workspace.getBoundingClientRect().right - toolbar.getBoundingClientRect().left) < 1, 'Toolbar overlaps workspace');
  cases++;
  await wait(() => !!useAppStore.getState().reader.htmlBook?.rendition?.getDocument()?.querySelector('[data-txt-start]'), 'Actual Reader TXT did not render');
  await wait(() => useAppStore.getState().book.isReading, 'Actual Reader did not finish first-document initialization');
  const rendition = () => useAppStore.getState().reader.htmlBook!.rendition;
  assert(rendition().isTxtWindowActive(), 'Continuous TXT mode was lost');
  const area = document.getElementById('page-area')!;
  for (const mode of ['scroll', 'single', 'double']) {
    const size = getPageWidth(mode, '1', 40, false, false);
    const width = parseFloat(size.pageWidth);
    assert(width > 0 && width <= workspace.clientWidth, `${mode} width exceeds workspace`);
    if (mode === 'double') assert(width <= workspace.clientWidth - 160, 'Double-page width includes toolbar');
  }
  const fit = getPageWidth('scroll', '1', 40, false, false, true);
  assert(parseFloat(fit.pageWidth) === workspace.clientWidth - 106, 'Fit-page width includes toolbar');
  assert(area.getBoundingClientRect().right < toolbar.getBoundingClientRect().left, 'Actual page intrudes into toolbar');
  cases++;
  // Native Chromium inputs verify browser selection defaults, not synthetic events.
  const delayNative = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const nativePoint = (start: number, end: number) => {
    const doc = rendition().getDocument()!;
    const node = doc.querySelector('[data-txt-start]')!.firstChild!;
    const range = doc.createRange(); range.setStart(node, start); range.setEnd(node, end);
    const rect = range.getBoundingClientRect(), frame = rendition().getIframe()!.getBoundingClientRect();
    return { x: Math.round(frame.left + rect.left + 1), y: Math.round(frame.top + rect.top + rect.height / 2), right: Math.round(frame.left + rect.right - 1) };
  };
  const point = nativePoint(2, 3);
  for (const count of [2, 3]) {
    rendition().getDocument()!.getSelection()!.removeAllRanges();
    await window.electronAPI.invoke('reader-toolbar-click', { x: point.x, y: point.y, count });
    await delayNative(60);
    assert(!rendition().getDocument()!.getSelection()!.toString(), `Native ${count}-click still selected words/lines`);
  }
  cases++;
  const dragPoint = nativePoint(0, 8);
  await window.electronAPI.invoke('reader-toolbar-drag', { x: dragPoint.x, y: dragPoint.y, endX: dragPoint.right });
  await wait(() => !!rendition().getDocument()!.getSelection()!.toString(), 'Single-press native drag selection stopped working');
  rendition().getDocument()!.getSelection()!.removeAllRanges();
  useAppStore.getState().handleOpenMenu(false);
  cases++;
  const scrollBefore = area.scrollTop;
  assert(getComputedStyle(area).scrollbarWidth === 'none' && getComputedStyle(area, '::-webkit-scrollbar').display === 'none', 'Reading scrollbar is still exposed');
  await window.electronAPI.invoke('reader-toolbar-wheel', { x: point.x, y: point.y });
  await wait(() => area.scrollTop > scrollBefore + 10, 'Hiding the scrollbar disabled native wheel scrolling');
  assert(getComputedStyle(area).scrollbarWidth === 'none', 'Hovering the reading text reveals the scrollbar');
  await rendition().goToChapterDocIndex(0);
  await delayNative(200);
  cases++;
  const stableRendition = rendition();
  const stableFrame = stableRendition.getIframe();
  const selectionDocument = stableRendition.getDocument()!;
  const selectedNode = selectionDocument.querySelector('[data-txt-start]')!.firstChild!;
  const range = selectionDocument.createRange();
  range.setStart(selectedNode, 0); range.setEnd(selectedNode, 4);
  selectionDocument.getSelection()!.removeAllRanges();
  selectionDocument.getSelection()!.addRange(range);
  const selectedText = selectionDocument.getSelection()!.toString();
  const navigation = document.getElementById('reader-navigation-panel')!;
  const settings = document.getElementById('reader-settings-panel')!;
  const main = document.querySelector<HTMLElement>('.reader-main')!;
  const mainWidth = main.clientWidth;
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  // Hovering either edge must never expose the former controls or open panels.
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: window.innerWidth - 70, clientY: 10, bubbles: true }));
  await delay(700);
  assert(!document.querySelector('.reader-toolbar-bookmark, .reader-quick-buttons, .reader-bottom-toolbar'), 'Former hover toolbars remain mounted');
  assert(navigation.hidden && settings.hidden && !document.querySelector('.quick-buttons-shown'), 'Hover opened a panel or hid chapter headers');
  cases++;

  buttons[0].click();
  await wait(() => !navigation.hidden && main.clientWidth === mainWidth, 'Directory button changed reading width');
  const pageBefore = area.getBoundingClientRect();
  const assertOverlay = (panel: HTMLElement) => {
    assert(getComputedStyle(panel).position === 'absolute' && panel.getBoundingClientRect().left < main.getBoundingClientRect().right && Math.abs(panel.getBoundingClientRect().right - toolbar.getBoundingClientRect().left) < 1, 'Panel does not float above the right side of the reading workspace');
    assert(main.clientWidth === mainWidth && Math.abs(area.getBoundingClientRect().width - pageBefore.width) < 1 && Math.abs(area.getBoundingClientRect().left - pageBefore.left) < 1, 'Floating panel resized or shifted the actual reading page');
  };
  assertOverlay(navigation);
  // Old pinned preferences must not double-reserve columns or prevent outside dismissal.
  flushSync(() => useAppStore.setState(state => ({ reader: { ...state.reader, isNavLocked: true, isSettingLocked: true } })));
  navigation.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: main }));
  main.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  await delay(700);
  assert(!navigation.hidden, 'Directory closes when the mouse leaves');
  assertOverlay(navigation);
  navigation.querySelector<HTMLElement>('.book-title')!.click();
  await delay(30);
  assert(!navigation.hidden, 'Clicking within directory dismissed it');
  await window.electronAPI.invoke('reader-toolbar-preview', 'navigation');
  main.click();
  await wait(() => navigation.hidden && main.clientWidth === mainWidth, 'Outside click did not dismiss directory/restore content width');
  cases++;

  buttons[2].click();
  await wait(() => !settings.hidden && main.clientWidth === mainWidth, 'Settings button changed reading width');
  settings.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: main }));
  await delay(700);
  assert(!settings.hidden, 'Settings closes when the mouse leaves');
  settings.querySelector<HTMLElement>('.setting-panel-title')!.click();
  await delay(30);
  assert(!settings.hidden, 'Clicking within settings dismissed it');
  assertOverlay(settings);
  await window.electronAPI.invoke('reader-toolbar-preview', 'settings');
  buttons[0].click();
  await wait(() => settings.hidden && !navigation.hidden, 'Toolbar did not switch between the two right panels');
  buttons[0].click();
  await wait(() => navigation.hidden && settings.hidden, 'Toolbar did not toggle the active panel closed');
  cases++;

  for (const index of [0, 2]) {
    buttons[index].click();
    const panel = index === 0 ? navigation : settings;
    await wait(() => !panel.hidden, 'Panel did not reopen');
    await delay(700);
    await wait(() => !!rendition().getDocument()?.querySelector('[data-txt-start]'), 'Resized TXT frame did not settle');
    rendition().getDocument()!.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(() => panel.hidden, 'Clicking actual TXT iframe did not dismiss panel');
  }
  flushSync(() => useAppStore.setState(state => ({ reader: { ...state.reader, isNavLocked: false, isSettingLocked: false } })));
  assert(rendition() === stableRendition && rendition().getIframe() === stableFrame, 'Panel changes replaced the continuous TXT rendition/frame');
  assert(selectionDocument.getSelection()!.toString() === selectedText, 'Panel changes lost the active source selection');
  selectionDocument.getSelection()!.removeAllRanges();
  cases++;
  buttons[0].click();
  await wait(() => !navigation.hidden, 'Directory did not reopen for chapter navigation');
  const chapterLink = navigation.querySelectorAll<HTMLElement>('.content-chapter-title')[5];
  assert(!!chapterLink, 'Directory chapter entry is missing');
  chapterLink.click();
  await wait(() => Number(rendition().getPosition().chapterDocIndex) === 5, 'Directory navigation failed');
  assert(!navigation.hidden, 'Choosing a directory chapter dismissed the panel');
  main.click();
  await wait(() => navigation.hidden && main.clientWidth === mainWidth, 'Directory did not close after navigation/outside click');
  cases++;
  const widthBeforeResize = workspace.clientWidth;
  await window.electronAPI.invoke('reader-toolbar-resize', 900);
  await wait(() => workspace.clientWidth < widthBeforeResize && !!rendition().getDocument()?.querySelector('[data-txt-start]'), 'Workspace failed to resize');
  await wait(() => Number(rendition().getPosition().chapterDocIndex) === 5, 'Resize lost reading chapter');
  assert(Math.abs(toolbar.getBoundingClientRect().left - workspace.getBoundingClientRect().right) < 1 && Math.abs(toolbar.getBoundingClientRect().right - window.innerWidth) <= 1, 'Resize overlaid toolbar');
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert(Number(rendition().getPosition().chapterDocIndex) === 5, 'Settled resize lost reading chapter');
  assert(getComputedStyle(toolbar).opacity === '1' && getComputedStyle(toolbar).visibility === 'visible', 'Toolbar follows transient top controls');
  cases++;
  ConfigService.setReaderConfig('textColor', '#ddd');
  flushSync(() => useAppStore.getState().handleBackgroundColor('#2c2f31'));
  assert(getComputedStyle(toolbar).backgroundColor === 'rgb(44, 47, 49)' && getComputedStyle(toolbar).color === 'rgb(221, 221, 221)', 'Toolbar does not follow reader theme');
  cases++;
  ConfigService.setReaderConfig('textColor', '#302d29');
  flushSync(() => useAppStore.getState().handleBackgroundColor('#f5f0e6'));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))));
  return { passed: true, cases, fullReader: true, continuousTxt: true, userDatabaseOpened: false };
}
