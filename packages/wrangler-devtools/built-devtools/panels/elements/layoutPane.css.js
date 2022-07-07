// Copyright 2022 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
// IMPORTANT: this file is auto generated. Please do not edit this file.
/* istanbul ignore file */
const styles = new CSSStyleSheet();
styles.replaceSync(
`/*
 * Copyright 2021 The Chromium Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

* {
  box-sizing: border-box;
  font-size: 12px;
}

.header {
  background-color: var(--color-background-elevation-1);
  border-bottom: var(--legacy-divider-border);
  line-height: 1.6;
  overflow: hidden;
  padding: 0 5px;
  white-space: nowrap;
}

.header::marker {
  color: rgb(110 110 110); /* stylelint-disable-line plugin/use_theme_colors */
  /* See: crbug.com/1152736 for color variable migration. */
  font-size: 11px;
  line-height: 1;
}

.header:focus {
  background-color: var(--legacy-focus-bg-color);
}

.content-section {
  padding: 16px;
  border-bottom: var(--legacy-divider-border);
  overflow-x: hidden;
}

.content-section-title {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.1;
  margin: 0;
  padding: 0;
}

.checkbox-settings {
  margin-top: 8px;
  display: grid;
  grid-template-columns: 1fr;
  gap: 5px;
}

.checkbox-label {
  display: flex;
  flex-direction: row;
  align-items: center;
  min-width: 40px;
}

.checkbox-settings .checkbox-label {
  margin-bottom: 8px;
}

.checkbox-settings .checkbox-label:last-child {
  margin-bottom: 0;
}

.checkbox-label input {
  margin: 0 6px 0 0;
  padding: 0;
  flex: none;
}

.checkbox-label input:focus {
  outline: auto 5px -webkit-focus-ring-color;
}

.checkbox-label > span {
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}

.select-settings {
  margin-top: 16px;
}

.select-label {
  display: flex;
  flex-direction: column;
}

.select-label span {
  margin-bottom: 4px;
}

.elements {
  margin-top: 12px;
  color: var(--color-token-tag);
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(250px, 100%), 1fr));
  gap: 8px;
}

.element {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.show-element {
  margin: 0 0 0 8px;
  padding: 0;
  background: none;
  border: none;
  -webkit-mask-image: var(--image-file-ic_show_node_16x16);
  background-color: #333; /* stylelint-disable-line plugin/use_theme_colors */
  /* See: crbug.com/1152736 for color variable migration. */
  width: 16px;
  height: 16px;
  display: block;
  cursor: pointer;
  flex: none;
}

.show-element:focus,
.show-element:hover {
  background-color: #6e6e6e; /* stylelint-disable-line plugin/use_theme_colors */
  /* See: crbug.com/1152736 for color variable migration. */
}

.chrome-select {
  min-width: 0;
  max-width: 150px;
}

:host-context(.-theme-with-dark-background) .show-element {
  background-color: rgb(204 204 204);
}

:host-context(.-theme-with-dark-background) .show-element:focus,
:host-context(.-theme-with-dark-background) .show-element:hover {
  background-color: #6e6e6e;
}

.color-picker {
  opacity: 0%;
}

.color-picker-label {
  border: 1px solid rgb(128 128 128 / 60%); /* stylelint-disable-line plugin/use_theme_colors */
  /* See: crbug.com/1152736 for color variable migration. */
  cursor: default;
  display: inline-block;
  flex: none;
  height: 10px;
  margin: 0 0 0 8px;
  width: 10px;
  position: relative;
}
/* We set dimensions for the invisible input to support quick highlight a11y feature
that uses the dimensions to draw an outline around the element. */
.color-picker-label input[type="color"] {
  width: 100%;
  height: 100%;
  position: absolute;
}

.color-picker-label:hover,
.color-picker-label:focus {
  border: 1px solid var(--legacy-accent-color-hover);
  transform: scale(1.2);
}

.node-text-container {
  line-height: 16px;
  padding: 0 0.5ex;
  border-radius: 5px;
}

.node-text-container:hover {
  background-color: var(--item-hover-color);
}

/*# sourceURL=layoutPane.css */
`);
export default styles;
