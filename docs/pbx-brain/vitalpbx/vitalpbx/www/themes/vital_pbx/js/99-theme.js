var mobile = false;
var asideNav = $("#aside-nav");
var navBar = $(".ombutelPBX .navbar");
var contentArea = $("#modules-content-area");
var navSearch = $("#nav-search");
var navBackDrop = $("#aside-backdrop");
var toggleSettings = $(".toggle-settings");
var openAside = $("#openAside");
var global_search_container = $("#global-search-container");
var topBar = $("#main-top-navbar");
var desk_logo = topBar.find("img#ombu-logo");
var mobile_logo = topBar.find("img#ombu-mobile-logo");

$(function () {
	$.shake({
		violence: 3.0,
		debounce: 1000,
		callback: toggleAside
	});

	$("#aside-navigation").find("a").click(function (e) {
		e.preventDefault();
		$(this).tab('show');
	});

	$("ul.children-menu li").find("a").click(function(e) {
		e.preventDefault();
		var checkElement = $(this).next();
		if ($(this).parent('li').parent('ul').hasClass('sub-menu')) {
			//We are on third level we don't need collapse anything
			return true;
		}

		$("ul.children-menu li").removeClass('active');
		$("ul.children-menu li a").removeClass('sub-menu-indicator-minus');
		$(this).closest('li').addClass('active');
		$(this).addClass('sub-menu-indicator-minus');
		if ((checkElement.is('ul')) && (checkElement.is(':visible'))) {
			$(this).closest('li').removeClass('active');
			$(this).removeClass('sub-menu-indicator-minus');
			checkElement.slideUp('normal');
		}

		if ((checkElement.is('ul')) && (!checkElement.is(':visible'))) {
			$('ul.children-menu ul:visible').slideUp('normal');
			checkElement.slideDown('normal');
		}

		if (checkElement.is('ul')) {
			return false;
		} else {
			return true;
		}
	});

	var scrollSettings = {
		wheelSpeed: 2,
		wheelPropagation: true,
		minScrollbarLength: 20
	};

	$("#module-menu-items").perfectScrollbar(scrollSettings);

	$("#aside-main-menu").perfectScrollbar(scrollSettings);

	$(".modal-open .modal").perfectScrollbar(scrollSettings);

	$("#search-open").click(function() {
		navSearch.fadeIn().show();
		navSearch.find('#ombutel-search').focus();
	});

	$("#close-global-search").click(function() {
		hideMainSearch();
	});

	navBackDrop.click(function () {
		toggleAside();
	});

	toggleSettings.click(function(){
		var asideMenu = $("#aside-main-menu");
		var quickMenu = $("#user-quick-menu");
		$(this).toggleClass('showing-settings');
		if($(this).hasClass('showing-settings')){
			$(this).find('i').removeClass('fa-caret-down').addClass('fa-caret-up');
			asideMenu.slideUp().hide();
			quickMenu.slideDown().show();
		}else{
			$(this).find('i').removeClass('fa-caret-up').addClass('fa-caret-down');
			quickMenu.slideUp().hide();
			asideMenu.slideDown().show();
		}
	});

	openAside.click(toggleAside);

	$("#mobile-search").click(function() {
		global_search_container.toggleClass('hidden-xs');
		global_search_container.find('#ombutel-search').focus();
	});

	var loginPage = $(".login-pbx-page");
	var not_installed_apps = loginPage.find('div.app-not-installed');
	var loginPanel = loginPage.find('button.btn-panel');
	var loginContent = $("div#login-content");
	var loginFormContainer = $("div.login-form-container");

	loginPanel.hide();

	//Show the login panel only if one of the Sonata APPs are installed and the login content div exists
	if(not_installed_apps.length === 3 || !loginContent.length){
		loginFormContainer.removeClass('hidden');
		loginContent.addClass('hidden');
	}

	var loginPBX = loginPage.find('div.pbx a.login');
	loginPBX.on('click', function (e) {
		e.preventDefault();

		loginFormContainer.removeClass('hidden');
		loginContent.addClass('hidden');
		loginPanel.show();
	});

	var addonLoggin = loginPage.find('div.app-not-installed a.login');
	addonLoggin.on('click', function (e) {
		e.preventDefault();

		loginFormContainer.removeClass('hidden');
		loginContent.addClass('hidden');
		loginPanel.show();
	});

	loginPanel.on('click', function (e) {
		e.preventDefault();

		loginFormContainer.addClass('hidden');
		loginContent.removeClass('hidden');
		loginPanel.hide();
	});

	//Show or Hide password for login and admin setup
	var withVP = $("input.with-vp");
	withVP.each(function () {
		var input = $(this);
		var visualizer = input.next('div.visualizer');
		var passwordField = input.hasClass('pwd-field');

		visualizer.unbind('click');
		visualizer.on('click', function () {
			if(input.hasClass('virtual-password') || input.attr('type') === 'password'){
				if(!passwordField){
					input.removeClass('virtual-password');
				}else{
					input.attr('type', 'text');
				}

				visualizer.html('<i class="fa fa-fw fa-eye-slash"></i>');
			}else{
				if(!passwordField){
					input.addClass('virtual-password');
				}else{
					input.attr('type', 'password');
				}

				visualizer.html('<i class="fa fa-fw fa-eye"></i>');
			}
		});
	});
});

function toggleAside() {
	$("#aside-nav").toggle({
		effect: 'slide',
		easing: 'swing',
		duration: '200',
		complete: function () {
			asideNav.toggleClass('aside-nav-closed');
			if(!mobile){
				contentArea.toggleClass('closeMenu');
			} else{
				if (navBackDrop.is(":visible")) {
					navBackDrop.hide();
				} else {
					navBackDrop.show();
				}
			}

			if (!asideNav.is(":visible")) {
				navBackDrop.hide();
			}

			mobileFrmActionsInteraction();
		}
	});
}

function mobileFrmActionsInteraction() {
	var contentWidth = $("#box-mod-content").width();
	var formActions = $(".frm-actions");
	if (formActions.length) {
		formActions.css('width', contentWidth);
		if(!asideNav.is(":visible")) {
			formActions.css('margin' , '0 -15px');
		} else {
			formActions.css('margin-left' , '-15px');
		}
	}
}


function mobileInteraction() {
	if (bodyWidth <= 1280) {
		mobile = true;
		asideNav.hide();
		asideNav.addClass('aside-nav-closed');
		navBar.addClass('is-mobile');
		contentArea.addClass('is-mobile');
		navBackDrop.hide();
		desk_logo.hide();
		mobile_logo.show();
		mobileFrmActionsInteraction();
	} else {
		mobile = false;
		navBar.removeClass('is-mobile');
		contentArea.removeClass('is-mobile closeMenu');
		asideNav.show();
		asideNav.removeClass('aside-nav-closed');
		navBackDrop.hide();
		desk_logo.show();
		mobile_logo.hide();
		mobileFrmActionsInteraction();
	}

	openAside.show();
}

function themeDelegate() {
	$("ul.module-tabs").tabdrop({
		text: 'MORE'
	});

	hideMainSearch();
}

function hideMainSearch(){
	global_search_container.addClass('hidden-xs');
}
