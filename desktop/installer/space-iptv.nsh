; =============================================================================
; Space IPTV Desktop — customizações do instalador/desinstalador NSIS
; =============================================================================
;
; Este arquivo é incluído pelo electron-builder via `nsis.include`
; (desktop/electron-builder.yml). O conteúdo entra no *cabeçalho compartilhado*
; das duas passagens de compilação do NSIS:
;
;   1ª passagem: instalador    (BUILD_UNINSTALLER NÒO definido)
;   2ª passagem: desinstalador (BUILD_UNINSTALLER definido)
;
; Ganchos usados — nomes confirmados nos templates do electron-builder 26.18.0
; (node_modules/app-builder-lib/templates/nsis/):
;
;   assistedInstaller.nsh:42  !ifmacrodef customPageAfterChangeDir  -> instalador
;   installer.nsi:45          !ifmacrodef customHeader             -> as 2 passagens
;   uninstaller.nsh:33        !ifmacrodef customUnInit             -> desinstalador
;   assistedInstaller.nsh:67  !ifmacrodef customUnWelcomePage      -> desinstalador
;   uninstaller.nsh:156       !ifmacrodef customUnInstall          -> desinstalador
;
; Por que as funções ficam dentro de `customHeader`: o cabeçalho é concatenado
; ANTES de installer.nsi, que por sua vez inclui MUI2, multiUser (+FileFunc) e
; nsDialogs. `customHeader` é expandido em installer.nsi:45, ou seja, DEPOIS de
; todos esses includes — único ponto seguro para funções que usam ${If},
; ${NSD_Create*}, MUI_HEADER_TEXT etc.
;
; Contrato (desktop/CONTRACTS.md §5):
;   - página "Pasta de downloads" após a página de destino (instalação assistida);
;   - grava HKCU\Software\Space IPTV\DownloadsDir (o app lê no primeiro run);
;   - instalação silenciosa (/S) usa o padrão e não pergunta nada;
;   - desinstalar remove atalhos (o builder já faz), autostart, cache/config do
;     app e, SÓ se o usuário marcar a opção (desmarcada por padrão), a pasta de
;     downloads registrada. Nunca apaga nada fora dela.
; =============================================================================

!define SPACE_REG_KEY "Software\Space IPTV"
!define SPACE_REG_DOWNLOADS "DownloadsDir"
!define SPACE_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define SPACE_DEFAULT_DOWNLOADS_DIR "$PROFILE\Videos\Space IPTV"

; --- variáveis globais -------------------------------------------------------
; O NSIS do electron-builder compila com warnings tratados como erro: variável
; declarada e não usada na passagem quebra o build. Por isso cada passagem só
; declara as variáveis que realmente usa.

; Comuns às duas passagens (helpers de busca textual / guardas)
Var spaceContainsResult     ; resultado de contains (0/1)
Var spaceNeedle             ; substring procurada / raiz comparada
Var spaceHaystack           ; texto onde procurar

!ifndef BUILD_UNINSTALLER
  ; --- instalador ---
  Var spaceDownloadsDir     ; pasta escolhida/validada
  Var spaceDlField          ; handle do campo de texto
  Var spaceDlBrowseButton   ; handle do botão "Procurar..."
  Var spaceDlErrorLabel     ; handle do rótulo de erro
  Var spaceDlErrorText      ; mensagem de erro corrente
!endif

!ifdef BUILD_UNINSTALLER
  ; --- desinstalador ---
  Var spaceUnDeleteDownloads ; "1" = apagar downloads (checkbox ou /delete-downloads)
  Var spaceUnDlDir           ; pasta de downloads registrada
  Var spaceUnDlCheckbox      ; handle do checkbox
  Var spaceUnDlText          ; texto do rótulo com a pasta registrada
  Var spaceUnRunIndex        ; índice de enumeração do Run
  Var spaceUnRunName         ; nome do valor do Run
  Var spaceUnRunData         ; dados do valor do Run
!endif

; =============================================================================
; Macros de página (expandidas nos pontos de declaração de páginas do builder)
; =============================================================================

; Página customizada exibida após a página de destino (MUI_PAGE_DIRECTORY).
!macro customPageAfterChangeDir
  Page custom spaceDlPageCreate spaceDlPageLeave
!macroend

; Página inicial do desinstalador, com o checkbox de downloads (desmarcado).
!macro customUnWelcomePage
  UninstPage custom un.spaceUnPageCreate un.spaceUnPageLeave
!macroend

; Inicialização do instalador: padrão = valor anterior do registro ou o padrão.
!macro customInit
  ReadRegStr $spaceDownloadsDir HKCU "${SPACE_REG_KEY}" "${SPACE_REG_DOWNLOADS}"
  ${If} $spaceDownloadsDir == ""
    StrCpy $spaceDownloadsDir "${SPACE_DEFAULT_DOWNLOADS_DIR}"
  ${EndIf}
!macroend

; Instalação (inclusive silenciosa): persiste a pasta escolhida no registro.
!macro customInstall
  ${If} $spaceDownloadsDir == ""
    StrCpy $spaceDownloadsDir "${SPACE_DEFAULT_DOWNLOADS_DIR}"
  ${EndIf}
  CreateDirectory "$spaceDownloadsDir"
  WriteRegStr HKCU "${SPACE_REG_KEY}" "${SPACE_REG_DOWNLOADS}" "$spaceDownloadsDir"
  DetailPrint "Pasta de downloads: $spaceDownloadsDir"
!macroend

; Inicialização do desinstalador: padrão seguro = não apagar downloads.
!macro customUnInit
  StrCpy $spaceUnDeleteDownloads "0"
  StrCpy $spaceUnDlDir ""
  ; /delete-downloads: usado por automação/teste (silencioso). Nunca é o padrão.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/delete-downloads" $R1
  ${IfNot} ${Errors}
    StrCpy $spaceUnDeleteDownloads "1"
  ${EndIf}
!macroend

; Remove dados do usuário durante a desinstalação.
!macro customUnInstall
  Call un.spaceUnCleanup
!macroend

; =============================================================================
; Funções (definidas só depois de todos os includes do builder)
; =============================================================================
!macro customHeader

  ; ---------------------------------------------------------------------------
  ; INSTALADOR — página "Pasta de downloads"
  ; ---------------------------------------------------------------------------
  !ifndef BUILD_UNINSTALLER

    Function spaceDlPageCreate
      !insertmacro MUI_HEADER_TEXT "Pasta de downloads" \
        "Escolha onde o Space IPTV vai salvar os vídeos baixados para assistir offline."

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0u 0u 300u 26u \
        "Filmes, séries e episódios baixados ficam nesta pasta.$\r$\nPadrão: %USERPROFILE%\Videos\Space IPTV (pode ser alterado depois em Configurações)."
      Pop $0

      ${NSD_CreateText} 0u 36u 236u 14u "$spaceDownloadsDir"
      Pop $spaceDlField

      ${NSD_CreateButton} 242u 36u 58u 14u "Procurar..."
      Pop $spaceDlBrowseButton
      ${NSD_OnClick} $spaceDlBrowseButton spaceDlBrowse

      ${NSD_CreateLabel} 0u 58u 300u 22u \
        "A pasta é criada se não existir. É preciso permissão de escrita nela.$\r$\nNenhum download é feito durante a instalação."
      Pop $0

      ; Área de erro reservada (sem empurrar/deslocar os controles ao aparecer)
      ${NSD_CreateLabel} 0u 84u 300u 30u ""
      Pop $spaceDlErrorLabel

      nsDialogs::Show
    FunctionEnd

    Function spaceDlBrowse
      ${NSD_GetText} $spaceDlField $0
      ${If} $0 == ""
        StrCpy $0 "$spaceDownloadsDir"
      ${EndIf}
      nsDialogs::SelectFolderDialog "Selecione a pasta de downloads do Space IPTV" "$0"
      Pop $1
      ${If} $1 != "error"
      ${AndIf} $1 != ""
        ${NSD_SetText} $spaceDlField "$1"
        ${NSD_SetText} $spaceDlErrorLabel ""
      ${EndIf}
    FunctionEnd

    Function spaceDlPageLeave
      ${NSD_GetText} $spaceDlField $spaceDownloadsDir
      StrCpy $spaceDlErrorText ""

      ; Remove aspas coladas pelo usuário ("C:\Vídeos" -> C:\Vídeos)
      StrCpy $1 $spaceDownloadsDir 1
      ${If} $1 == '"'
        StrCpy $spaceDownloadsDir $spaceDownloadsDir "" 1
        StrCpy $1 $spaceDownloadsDir 1 -1
        ${If} $1 == '"'
          StrCpy $spaceDownloadsDir $spaceDownloadsDir -1
        ${EndIf}
      ${EndIf}

      ; Remove barras e espaços finais (preserva a raiz o suficiente para recusá-la)
      spaceDlTrimLoop:
        StrCpy $1 $spaceDownloadsDir 1 -1
        ${If} $1 == "\"
        ${OrIf} $1 == " "
          StrCpy $spaceDownloadsDir $spaceDownloadsDir -1
          Goto spaceDlTrimLoop
        ${EndIf}

      ${If} $spaceDownloadsDir == ""
        StrCpy $spaceDlErrorText "Informe uma pasta."
      ${ElseIf} $spaceDownloadsDir == "."
      ${OrIf} $spaceDownloadsDir == ".."
        StrCpy $spaceDlErrorText "Informe um caminho completo (ex.: D:\Vídeos\Space IPTV)."
      ${EndIf}

      ; '..' é recusado no instalador para o desinstalador nunca sair do caminho
      StrCpy $spaceNeedle ".."
      StrCpy $spaceHaystack "$spaceDownloadsDir"
      Call spaceDlContains
      ${If} $spaceContainsResult == "1"
        StrCpy $spaceDlErrorText "O caminho não pode conter '..'. Escolha uma pasta direta."
      ${EndIf}

      ; Recusa raízes de unidade ("C:", "C:\")
      StrLen $0 $spaceDownloadsDir
      ${If} $0 < 4
      ${AndIf} $spaceDlErrorText == ""
        StrCpy $spaceDlErrorText "Escolha uma pasta dentro de uma unidade, não a raiz."
      ${EndIf}

      ; Cria a pasta e testa a escrita de verdade (arquivo temporário)
      ${If} $spaceDlErrorText == ""
        CreateDirectory "$spaceDownloadsDir"
        ClearErrors
        FileOpen $0 "$spaceDownloadsDir\.space-iptv-write-test.tmp" w
        ${If} ${Errors}
          StrCpy $spaceDlErrorText "Não foi possível gravar nessa pasta. Verifique as permissões ou escolha outra."
        ${Else}
          FileWrite $0 "space-iptv"
          FileClose $0
          Delete "$spaceDownloadsDir\.space-iptv-write-test.tmp"
          ClearErrors
        ${EndIf}
      ${EndIf}

      ${If} $spaceDlErrorText != ""
        ${NSD_SetText} $spaceDlErrorLabel "$spaceDlErrorText"
        Abort
      ${EndIf}

      ${NSD_SetText} $spaceDlErrorLabel ""
    FunctionEnd

    ; "contém" simples e case-insensitive (StrCmp do NSIS já é case-insensitive)
    ; Entrada: $spaceNeedle, $spaceHaystack. Saída: $spaceContainsResult (0/1)
    Function spaceDlContains
      Push $R0
      Push $R1
      Push $R2
      Push $R3
      StrCpy $spaceContainsResult "0"
      StrLen $R0 $spaceNeedle
      ${If} $R0 > 0
        StrCpy $R1 $spaceHaystack
        ${DoWhile} 1 = 1
          StrLen $R2 $R1
          ${If} $R2 < $R0
            ${ExitDo}
          ${EndIf}
          StrCpy $R3 $R1 $R0
          ${If} $R3 == $spaceNeedle
            StrCpy $spaceContainsResult "1"
            ${ExitDo}
          ${EndIf}
          ${If} $R2 == 0
            ${ExitDo}
          ${EndIf}
          StrCpy $R1 $R1 "" 1
        ${Loop}
      ${EndIf}
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
    FunctionEnd

  !endif ; BUILD_UNINSTALLER

  ; ---------------------------------------------------------------------------
  ; DESINSTALADOR
  ; ---------------------------------------------------------------------------
  !ifdef BUILD_UNINSTALLER

    Function un.spaceUnPageCreate
      !insertmacro MUI_HEADER_TEXT "Desinstalar Space IPTV" \
        "Confirme o que deve ser removido desta máquina."

      ReadRegStr $spaceUnDlDir HKCU "${SPACE_REG_KEY}" "${SPACE_REG_DOWNLOADS}"

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0u 0u 300u 26u \
        "Os atalhos, a inicialização com o Windows, as configurações e o cache do Space IPTV serão removidos."
      Pop $0

      ${If} $spaceUnDlDir == ""
        StrCpy $spaceUnDlText "Nenhuma pasta de downloads registrada pelo instalador."
      ${Else}
        StrCpy $spaceUnDlText "Pasta de downloads registrada: $spaceUnDlDir"
      ${EndIf}
      ${NSD_CreateLabel} 0u 32u 300u 24u "$spaceUnDlText"
      Pop $0

      ; Checkbox DESMARCADO por padrão: preserva os vídeos baixados.
      ${NSD_CreateCheckbox} 0u 62u 300u 16u "Apagar também a pasta de downloads (vídeos baixados)"
      Pop $spaceUnDlCheckbox
      ${NSD_SetState} $spaceUnDlCheckbox ${BST_UNCHECKED}
      ${If} $spaceUnDlDir == ""
        EnableWindow $spaceUnDlCheckbox 0
      ${EndIf}

      ${NSD_CreateLabel} 0u 84u 300u 28u \
        "Desmarcado (padrão): os vídeos baixados são mantidos.$\r$\nSe marcar, somente a pasta registrada acima será apagada — nada fora dela."
      Pop $0

      nsDialogs::Show
    FunctionEnd

    Function un.spaceUnPageLeave
      ${NSD_GetState} $spaceUnDlCheckbox $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $spaceUnDeleteDownloads "1"
      ${Else}
        StrCpy $spaceUnDeleteDownloads "0"
      ${EndIf}
    FunctionEnd

    ; Limpeza executada na seção de desinstalação (antes de apagar os arquivos).
    Function un.spaceUnCleanup
      ; Atualização (--updated): o builder desinstala a versão antiga antes de
      ; instalar a nova. Nunca apagar dados/autostart nesse caminho.
      ${If} ${isUpdated}
        DetailPrint "Atualização: dados do usuário preservados."
        Return
      ${EndIf}

      Call un.spaceUnRemoveAutostart

      ; Cache/config do app (Electron userData) em Roaming e Local.
      ; Nomes: produto, diretório de instalação e nome do pacote.
      RMDir /r "$APPDATA\${PRODUCT_NAME}"
      RMDir /r "$APPDATA\${APP_FILENAME}"
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
      RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}"
      RMDir /r "$LOCALAPPDATA\${APP_FILENAME}"
      RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}"

      ; Pasta de downloads: só com confirmação explícita do usuário.
      ${If} $spaceUnDeleteDownloads == "1"
        Call un.spaceUnRemoveDownloads
      ${EndIf}

      ; Chave de integração gravada pelo instalador (depois de ler o DownloadsDir)
      DeleteRegKey HKCU "${SPACE_REG_KEY}"
    FunctionEnd

    ; Remove valores do autostart que apontem para este aplicativo.
    Function un.spaceUnRemoveAutostart
      Push $R0
      Push $R1
      Push $R2
      Push $R3

      ; Nomes conhecidos (Electron usa o nome do app; cobrimos variações)
      DeleteRegValue HKCU "${SPACE_RUN_KEY}" "${PRODUCT_NAME}"
      DeleteRegValue HKCU "${SPACE_RUN_KEY}" "${APP_PACKAGE_NAME}"

      ; Varredura: qualquer valor apontando para o executável instalado
      StrCpy $spaceUnRunIndex 0
      StrCpy $R3 0
      spaceUnRunLoop:
        IntCmp $R3 250 spaceUnRunDone
        IntOp $R3 $R3 + 1
        ClearErrors
        EnumRegValue $spaceUnRunName HKCU "${SPACE_RUN_KEY}" $spaceUnRunIndex
        IfErrors spaceUnRunDone
        StrCmp $spaceUnRunName "" spaceUnRunDone
        ReadRegStr $spaceUnRunData HKCU "${SPACE_RUN_KEY}" "$spaceUnRunName"

        StrCpy $spaceNeedle "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        StrCpy $spaceHaystack "$spaceUnRunData"
        Call un.spaceUnContains
        StrCmp $spaceContainsResult "1" spaceUnRunDelete

        StrCpy $spaceNeedle "${APP_EXECUTABLE_FILENAME}"
        StrCpy $spaceHaystack "$spaceUnRunData"
        Call un.spaceUnContains
        StrCmp $spaceContainsResult "1" spaceUnRunDelete

        IntOp $spaceUnRunIndex $spaceUnRunIndex + 1
        Goto spaceUnRunLoop

      spaceUnRunDelete:
        DeleteRegValue HKCU "${SPACE_RUN_KEY}" "$spaceUnRunName"
        ; A enumeração desloca após remover: repete o mesmo índice.
        Goto spaceUnRunLoop

      spaceUnRunDone:
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
    FunctionEnd

    ; Apaga a pasta de downloads REGISTRADA, com guardas de segurança.
    ; Nunca apaga raiz de unidade, perfil, Windows, Program Files, AppData ou
    ; a própria pasta de instalação — e nada fora do caminho registrado.
    Function un.spaceUnRemoveDownloads
      ReadRegStr $spaceUnDlDir HKCU "${SPACE_REG_KEY}" "${SPACE_REG_DOWNLOADS}"
      StrCmp $spaceUnDlDir "" spaceUnDelDone

      ; Comprimento mínimo: recusa "" / "C:" / "C:\"
      StrLen $R0 $spaceUnDlDir
      IntCmp $R0 3 spaceUnDelDone spaceUnDelDone spaceUnDelOk
      spaceUnDelOk:

      ; Não pode ser a própria pasta de instalação
      StrCmp $spaceUnDlDir "$INSTDIR" spaceUnDelDone

      ; Não pode conter '..'
      StrCpy $spaceNeedle ".."
      StrCpy $spaceHaystack "$spaceUnDlDir"
      Call un.spaceUnContains
      StrCmp $spaceContainsResult "1" spaceUnDelDone

      ; Não pode ser ancestral de pastas protegidas (C:\, C:\Users, ...)
      StrCpy $spaceNeedle "$PROFILE"
      Call un.spaceUnIsAncestorOf
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      StrCpy $spaceNeedle "$INSTDIR"
      Call un.spaceUnIsAncestorOf
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      StrCpy $spaceNeedle "$WINDIR"
      Call un.spaceUnIsAncestorOf
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      StrCpy $spaceNeedle "$APPDATA"
      Call un.spaceUnIsAncestorOf
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      StrCpy $spaceNeedle "$LOCALAPPDATA"
      Call un.spaceUnIsAncestorOf
      StrCmp $spaceContainsResult "1" spaceUnDelDone

      ; Não pode estar dentro de pastas de sistema/instalação
      StrCpy $spaceNeedle "$WINDIR"
      Call un.spaceUnIsInside
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      StrCpy $spaceNeedle "$SYSDIR"
      Call un.spaceUnIsInside
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      StrCpy $spaceNeedle "$PROGRAMFILES"
      Call un.spaceUnIsInside
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      StrCpy $spaceNeedle "$INSTDIR"
      Call un.spaceUnIsInside
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      StrCpy $spaceNeedle "$APPDATA"
      Call un.spaceUnIsInside
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      StrCpy $spaceNeedle "$LOCALAPPDATA"
      Call un.spaceUnIsInside
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      StrCpy $spaceNeedle "$PROGRAMFILES64"
      StrCmp $spaceNeedle "" spaceUnDelSkipPF64
      Call un.spaceUnIsInside
      StrCmp $spaceContainsResult "1" spaceUnDelDone
      spaceUnDelSkipPF64:

      DetailPrint "Removendo pasta de downloads: $spaceUnDlDir"
      RMDir /r "$spaceUnDlDir"

      spaceUnDelDone:
    FunctionEnd

    ; Saída "1" se $spaceUnDlDir é igual a, ou está DENTRO de, $spaceNeedle.
    Function un.spaceUnIsInside
      StrCpy $spaceContainsResult "0"
      StrLen $R0 $spaceNeedle
      StrCmp $R0 0 spaceUnInsideDone
      StrLen $R1 $spaceUnDlDir
      IntCmp $R1 $R0 0 spaceUnInsideDone spaceUnInsideCheck
      spaceUnInsideCheck:
        StrCpy $R2 $spaceUnDlDir $R0
        StrCmp $R2 $spaceNeedle 0 spaceUnInsideDone
        StrCpy $spaceContainsResult "1"
      spaceUnInsideDone:
    FunctionEnd

    ; Saída "1" se $spaceUnDlDir é ancestral (ou igual) de $spaceNeedle.
    Function un.spaceUnIsAncestorOf
      StrCpy $spaceContainsResult "0"
      StrLen $R0 $spaceUnDlDir
      StrCmp $R0 0 spaceUnAncDone
      StrCpy $R2 $spaceNeedle $R0
      StrCmp $R2 $spaceUnDlDir 0 spaceUnAncDone
      StrCpy $spaceContainsResult "1"
      spaceUnAncDone:
    FunctionEnd

    ; "contém" simples e case-insensitive. Saída: $spaceContainsResult (0/1)
    Function un.spaceUnContains
      Push $R0
      Push $R1
      Push $R2
      Push $R3
      StrCpy $spaceContainsResult "0"
      StrLen $R0 $spaceNeedle
      ${If} $R0 > 0
        StrCpy $R1 $spaceHaystack
        ${DoWhile} 1 = 1
          StrLen $R2 $R1
          ${If} $R2 < $R0
            ${ExitDo}
          ${EndIf}
          StrCpy $R3 $R1 $R0
          ${If} $R3 == $spaceNeedle
            StrCpy $spaceContainsResult "1"
            ${ExitDo}
          ${EndIf}
          ${If} $R2 == 0
            ${ExitDo}
          ${EndIf}
          StrCpy $R1 $R1 "" 1
        ${Loop}
      ${EndIf}
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
    FunctionEnd

  !endif ; BUILD_UNINSTALLER

!macroend ; customHeader
