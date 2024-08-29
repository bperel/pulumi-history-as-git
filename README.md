[![npm version](https://badge.fury.io/js/pulumi-history-as-git.svg)](https://badge.fury.io/js/pulumi-history-as-git)

## pulumi-history-as-git

https://github.com/user-attachments/assets/faa7aa73-7605-4e8e-aa5b-c831e1225b14

An easy way to check the history of a Pulumi stack using Git commands.

## Usage

`npx pulumi-history-as-git [--keep-ciphertext=false]`

If `--keep-ciphertext` is set to `true`, the script will keep the ciphertext in the history. Usually you don't want to do that as it changes on every stack update.

### On a local environment

`npx ts-node index.ts [--keep-ciphertext=false]`
