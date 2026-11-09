import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import Reader from '/src/pages/reader/component.tsx';
import { ConfigService } from '/src/assets/lib/kookit-extra-browser.min';
import { useAppStore } from '/src/store/useAppStore.ts';
import { getPageWidth } from '/src/utils/common.ts';
import { changeLanguage } from '/src/i18n.tsx';
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
  buttons[0].click();
  await wait(() => buttons[0].getAttribute('aria-expanded') === 'true', 'Directory button did not open existing navigation');
  buttons[0].click();
  await wait(() => buttons[0].getAttribute('aria-expanded') === 'false', 'Directory button did not toggle closed');
  buttons[2].click();
  await wait(() => buttons[2].getAttribute('aria-expanded') === 'true', 'Settings button did not open existing settings');
  await new Promise(resolve => setTimeout(resolve, 550));
  await wait(() => document.getElementById('reader-settings-panel')!.getBoundingClientRect().right <= toolbar.getBoundingClientRect().left + 1, 'Settings obscures toolbar: ' + JSON.stringify({ settings: document.getElementById('reader-settings-panel')!.getBoundingClientRect().toJSON(), toolbar: toolbar.getBoundingClientRect().toJSON(), transform: getComputedStyle(document.getElementById('reader-settings-panel')!).transform }));
  buttons[2].click();
  cases++;
  await rendition().goToChapterDocIndex(5);
  await wait(() => Number(rendition().getPosition().chapterDocIndex) === 5, 'Directory navigation failed');
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
  return { passed: true, cases, fullReader: true, continuousTxt: true, userDatabaseOpened: false };
}
