(function () {
	bind_click_functions();

	function bind_click_functions() {
		$('div#server_type label.btn-radio').bind('click', function() {
			server_type($(this).children("input[type=radio]").val());
		});

		$('div#provider_type label.btn-radio').bind('click', function() {
			provider_type($(this).children("input[type=radio]").val());
		});

		$('div#auth label.btn-radio').bind('click', function() {
			auth($(this).children("input[type=radio]").val());
		});
	}

	function server_type(server_type) {
		switch(server_type) {
			case 'internal': {
				$('div.internal_settings').slideDown();
				$('div.external_settings').slideUp();
				break;
			}
			case 'external': {
				$('div.internal_settings').slideUp();
				$('div.external_settings').slideDown();
				break;
			}
		}
	}

	function provider_type(provider_type) {
		switch(provider_type) {
			case 'other': {
				if($('div#auth label.btn-radio').children("input[type=radio]:checked").val() == '0') {
				$('div.extern_other_auth').slideUp();
				}
					$('div.extern_other_settings').slideDown();
				break;
			}
			case 'gmail': {
				$('div.extern_other_settings').slideUp();
				$('div.extern_other_auth').slideDown();
				break;
			}
		}
	}

	function auth(auth) {
		switch(auth) {
			case '1': {
				$('div.extern_other_auth').slideDown();
				break;
			}
			case '0': {
				$('div.extern_other_auth').slideUp();
				break;
			}
		}
	}
})();
