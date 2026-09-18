# Loopcom Acceptance App — a safe local Windows application for proving Loopcom
# Computer Control (Phase 43 of the 2026-09-18 brief).
#
# It has every standard control kind (text field, checkbox, radio buttons, dropdown,
# tabs, menu, tree, table, a modal dialog, a file picker) AND one custom-drawn
# control that UI Automation cannot see (the purple square: a Pane with no name and
# no patterns), so both the buttons-first path and the vision fallback can be
# proven. Every change writes the app's state to a JSON file that the acceptance
# harness reads INDEPENDENTLY of the Coworker's own claims.
#
#   powershell -ExecutionPolicy Bypass -File acceptance-app.ps1 [-StateDir <dir>]
#
# State files (in -StateDir, default %USERPROFILE%\LoopcomCoworkerAcceptance):
#   acceptance-app-live.json   rewritten on EVERY change
#   acceptance-app-state.json  written when Save is pressed (File > Save or the button)
param([string] $StateDir = (Join-Path $env:USERPROFILE "LoopcomCoworkerAcceptance"))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
try { Add-Type @"
using System.Runtime.InteropServices;
public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@; [Dpi]::SetProcessDPIAware() | Out-Null } catch {}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$script:state = [ordered]@{ name = ""; enableFeature = $false; option = "A"; priority = "Normal"; tab = "General"; advancedFlag = $false; settingsDialogOk = 0; customClicks = 0; chosenFile = ""; treeSelection = ""; tableSelection = ""; saves = 0; lastEvent = "started" }
function Write-State([string] $file, [string] $event) {
  $script:state.lastEvent = $event
  $script:state.at = (Get-Date).ToString("o")
  ($script:state | ConvertTo-Json -Compress) | Set-Content -Path (Join-Path $StateDir $file) -Encoding UTF8
}
function Live([string] $event) { Write-State "acceptance-app-live.json" $event }

$form = New-Object System.Windows.Forms.Form
$form.Text = "Loopcom Acceptance App"
$form.Name = "LoopcomAcceptanceApp"
$form.Size = New-Object System.Drawing.Size(720, 640)
$form.StartPosition = "CenterScreen"
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

# ── menu ──
$menu = New-Object System.Windows.Forms.MenuStrip
$file = New-Object System.Windows.Forms.ToolStripMenuItem("File")
$miSave = New-Object System.Windows.Forms.ToolStripMenuItem("Save")
$miSettings = New-Object System.Windows.Forms.ToolStripMenuItem("Open Settings...")
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem("Exit")
[void]$file.DropDownItems.AddRange(@($miSave, $miSettings, $miExit))
$help = New-Object System.Windows.Forms.ToolStripMenuItem("Help")
$miAbout = New-Object System.Windows.Forms.ToolStripMenuItem("About")
[void]$help.DropDownItems.Add($miAbout)
[void]$menu.Items.AddRange(@($file, $help))
$form.MainMenuStrip = $menu
$form.Controls.Add($menu)

# ── tabs ──
$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Location = New-Object System.Drawing.Point(12, 34)
$tabs.Size = New-Object System.Drawing.Size(680, 520)
$tabs.AccessibleName = "Sections"
$tabGeneral = New-Object System.Windows.Forms.TabPage("General")
$tabAdvanced = New-Object System.Windows.Forms.TabPage("Advanced")
$tabData = New-Object System.Windows.Forms.TabPage("Data")
[void]$tabs.TabPages.AddRange(@($tabGeneral, $tabAdvanced, $tabData))
$form.Controls.Add($tabs)

# General tab
$lblName = New-Object System.Windows.Forms.Label; $lblName.Text = "Name"; $lblName.Location = New-Object System.Drawing.Point(16, 20); $lblName.AutoSize = $true
$txtName = New-Object System.Windows.Forms.TextBox; $txtName.Location = New-Object System.Drawing.Point(120, 16); $txtName.Size = New-Object System.Drawing.Size(300, 27); $txtName.AccessibleName = "Name"; $txtName.Name = "NameBox"
$chkEnable = New-Object System.Windows.Forms.CheckBox; $chkEnable.Text = "Enable Feature"; $chkEnable.Location = New-Object System.Drawing.Point(120, 56); $chkEnable.AutoSize = $true; $chkEnable.Name = "EnableFeature"
$grpOpt = New-Object System.Windows.Forms.GroupBox; $grpOpt.Text = "Options"; $grpOpt.Location = New-Object System.Drawing.Point(120, 92); $grpOpt.Size = New-Object System.Drawing.Size(300, 60)
$radA = New-Object System.Windows.Forms.RadioButton; $radA.Text = "Option A"; $radA.Location = New-Object System.Drawing.Point(12, 24); $radA.AutoSize = $true; $radA.Checked = $true; $radA.Name = "OptionA"
$radB = New-Object System.Windows.Forms.RadioButton; $radB.Text = "Option B"; $radB.Location = New-Object System.Drawing.Point(140, 24); $radB.AutoSize = $true; $radB.Name = "OptionB"
$grpOpt.Controls.AddRange(@($radA, $radB))
$lblPri = New-Object System.Windows.Forms.Label; $lblPri.Text = "Priority"; $lblPri.Location = New-Object System.Drawing.Point(16, 168); $lblPri.AutoSize = $true
$cmbPri = New-Object System.Windows.Forms.ComboBox; $cmbPri.Location = New-Object System.Drawing.Point(120, 164); $cmbPri.Size = New-Object System.Drawing.Size(200, 27); $cmbPri.DropDownStyle = "DropDownList"; $cmbPri.AccessibleName = "Priority"; $cmbPri.Name = "Priority"
[void]$cmbPri.Items.AddRange(@("Low", "Normal", "High")); $cmbPri.SelectedItem = "Normal"
$btnSettings = New-Object System.Windows.Forms.Button; $btnSettings.Text = "Open Settings"; $btnSettings.Location = New-Object System.Drawing.Point(120, 210); $btnSettings.Size = New-Object System.Drawing.Size(140, 32); $btnSettings.Name = "OpenSettings"
$btnFile = New-Object System.Windows.Forms.Button; $btnFile.Text = "Choose file..."; $btnFile.Location = New-Object System.Drawing.Point(270, 210); $btnFile.Size = New-Object System.Drawing.Size(140, 32); $btnFile.Name = "ChooseFile"
$btnSave = New-Object System.Windows.Forms.Button; $btnSave.Text = "Save"; $btnSave.Location = New-Object System.Drawing.Point(120, 254); $btnSave.Size = New-Object System.Drawing.Size(140, 36); $btnSave.Name = "SaveButton"
$lblStatus = New-Object System.Windows.Forms.Label; $lblStatus.Text = "Not saved yet"; $lblStatus.Location = New-Object System.Drawing.Point(16, 306); $lblStatus.AutoSize = $true; $lblStatus.Name = "Status"; $lblStatus.AccessibleName = "Status"

# The custom visual control: a purple square drawn by hand. NO accessible name, NO
# role, NO patterns — UI Automation lists it as an anonymous Pane at best, which the
# Coworker's control reader filters out. Only vision can find it.
$custom = New-Object System.Windows.Forms.Panel
$custom.Location = New-Object System.Drawing.Point(470, 20); $custom.Size = New-Object System.Drawing.Size(160, 160)
$custom.BackColor = [System.Drawing.Color]::FromArgb(128, 0, 200)
$custom.AccessibleRole = [System.Windows.Forms.AccessibleRole]::None
$custom.TabStop = $false
$custom.Add_Paint({ param($s, $e) $e.Graphics.FillEllipse([System.Drawing.Brushes]::MediumOrchid, 40, 40, 80, 80) })
$lblCustom = New-Object System.Windows.Forms.Label; $lblCustom.Text = "Custom control clicked 0 times"; $lblCustom.Location = New-Object System.Drawing.Point(470, 190); $lblCustom.AutoSize = $true; $lblCustom.Name = "CustomCount"; $lblCustom.AccessibleName = "Custom control clicks"
$custom.Add_Click({ $script:state.customClicks++; $lblCustom.Text = "Custom control clicked $($script:state.customClicks) times"; $custom.BackColor = [System.Drawing.Color]::FromArgb(60, 180, 60); Live "custom_click" })
$tabGeneral.Controls.AddRange(@($lblName, $txtName, $chkEnable, $grpOpt, $lblPri, $cmbPri, $btnSettings, $btnFile, $btnSave, $lblStatus, $custom, $lblCustom))

# Advanced tab
$chkAdv = New-Object System.Windows.Forms.CheckBox; $chkAdv.Text = "Advanced flag"; $chkAdv.Location = New-Object System.Drawing.Point(16, 20); $chkAdv.AutoSize = $true; $chkAdv.Name = "AdvancedFlag"
$tree = New-Object System.Windows.Forms.TreeView; $tree.Location = New-Object System.Drawing.Point(16, 60); $tree.Size = New-Object System.Drawing.Size(280, 240); $tree.AccessibleName = "Folders"
$root = $tree.Nodes.Add("Customers"); [void]$root.Nodes.Add("ABC Supply"); [void]$root.Nodes.Add("Loopcom"); $root2 = $tree.Nodes.Add("Vendors"); [void]$root2.Nodes.Add("Telnyx"); $root.Expand()
$tree.Add_AfterSelect({ $script:state.treeSelection = $tree.SelectedNode.Text; Live "tree_select" })
$slider = New-Object System.Windows.Forms.TrackBar; $slider.Location = New-Object System.Drawing.Point(320, 60); $slider.Size = New-Object System.Drawing.Size(300, 45); $slider.Minimum = 0; $slider.Maximum = 10; $slider.Value = 5; $slider.AccessibleName = "Level"
$slider.Add_ValueChanged({ $script:state.level = $slider.Value; Live "slider" })
$tabAdvanced.Controls.AddRange(@($chkAdv, $tree, $slider))

# Data tab
$grid = New-Object System.Windows.Forms.DataGridView; $grid.Location = New-Object System.Drawing.Point(16, 16); $grid.Size = New-Object System.Drawing.Size(640, 300); $grid.AccessibleName = "Invoices"
$grid.ColumnCount = 3; $grid.Columns[0].Name = "Vendor"; $grid.Columns[1].Name = "Amount"; $grid.Columns[2].Name = "Status"
[void]$grid.Rows.Add("ABC Supply", "1250.00", "Open"); [void]$grid.Rows.Add("Telnyx", "26.32", "Paid"); [void]$grid.Rows.Add("Contabo", "40.00", "Open")
$grid.AllowUserToAddRows = $false; $grid.ReadOnly = $true; $grid.SelectionMode = "FullRowSelect"
$grid.Add_SelectionChanged({ if ($grid.SelectedRows.Count -gt 0) { $script:state.tableSelection = [string]$grid.SelectedRows[0].Cells[0].Value; Live "table_select" } })
$tabData.Controls.Add($grid)

# ── events ──
$txtName.Add_TextChanged({ $script:state.name = $txtName.Text; Live "name" })
$chkEnable.Add_CheckedChanged({ $script:state.enableFeature = $chkEnable.Checked; Live "enable" })
$radA.Add_CheckedChanged({ if ($radA.Checked) { $script:state.option = "A"; Live "option" } })
$radB.Add_CheckedChanged({ if ($radB.Checked) { $script:state.option = "B"; Live "option" } })
$cmbPri.Add_SelectedIndexChanged({ $script:state.priority = [string]$cmbPri.SelectedItem; Live "priority" })
$tabs.Add_SelectedIndexChanged({ $script:state.tab = $tabs.SelectedTab.Text; Live "tab" })
$chkAdv.Add_CheckedChanged({ $script:state.advancedFlag = $chkAdv.Checked; Live "advanced" })

$doSave = { $script:state.saves++; Write-State "acceptance-app-state.json" "save"; Live "save"; $lblStatus.Text = "Saved $($script:state.saves) time(s) at $(Get-Date -Format 'HH:mm:ss')" }
$btnSave.Add_Click($doSave); $miSave.Add_Click($doSave)

$openSettings = {
  $dlg = New-Object System.Windows.Forms.Form; $dlg.Text = "Settings"; $dlg.Size = New-Object System.Drawing.Size(360, 200); $dlg.StartPosition = "CenterParent"; $dlg.FormBorderStyle = "FixedDialog"; $dlg.MinimizeBox = $false; $dlg.MaximizeBox = $false
  $chk = New-Object System.Windows.Forms.CheckBox; $chk.Text = "Send reports weekly"; $chk.Location = New-Object System.Drawing.Point(20, 24); $chk.AutoSize = $true; $chk.Checked = [bool]$script:state.weekly
  $ok = New-Object System.Windows.Forms.Button; $ok.Text = "OK"; $ok.Location = New-Object System.Drawing.Point(150, 110); $ok.DialogResult = "OK"
  $cancel = New-Object System.Windows.Forms.Button; $cancel.Text = "Cancel"; $cancel.Location = New-Object System.Drawing.Point(240, 110); $cancel.DialogResult = "Cancel"
  $dlg.Controls.AddRange(@($chk, $ok, $cancel)); $dlg.AcceptButton = $ok; $dlg.CancelButton = $cancel
  Live "settings_open"
  if ($dlg.ShowDialog($form) -eq "OK") { $script:state.weekly = $chk.Checked; $script:state.settingsDialogOk++; Live "settings_ok" } else { Live "settings_cancel" }
}
$btnSettings.Add_Click($openSettings); $miSettings.Add_Click($openSettings)
$btnFile.Add_Click({
  $ofd = New-Object System.Windows.Forms.OpenFileDialog; $ofd.InitialDirectory = $StateDir; $ofd.Title = "Choose a file"
  Live "file_dialog_open"
  if ($ofd.ShowDialog($form) -eq "OK") { $script:state.chosenFile = $ofd.FileName; Live "file_chosen" } else { Live "file_cancel" }
})
$miAbout.Add_Click({ [System.Windows.Forms.MessageBox]::Show($form, "Loopcom Acceptance App`nA safe target for proving Loopcom Computer Control.", "About") | Out-Null })
$miExit.Add_Click({ $form.Close() })
$form.Add_FormClosed({ Live "closed" })

Live "started"
[void]$form.ShowDialog()
